'use client'

import { useEffect, useState, useCallback, useRef, memo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

type Player = { id: string; name: string }
type Match = {
  id: string; room_id: string; round: number; position: number
  player1_id: string | null; player2_id: string | null
  player1_song: string | null; player2_song: string | null
  winner_id: string | null; status: string
}
type Vote = { id: string; match_id: string; voter_name: string; voted_for: string }
type Reaction = { id: string; emoji: string; x: number }

const SONG_TIMER = 45

function getEmbedUrl(url: string) {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  if (yt) return `https://www.youtube.com/embed/${yt[1]}?autoplay=1&mute=1&controls=1&rel=0&modestbranding=1&enablejsapi=1`
  const sp = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/)
  if (sp) return `https://open.spotify.com/embed/${sp[1]}/${sp[2]}`
  return null
}

function pName(players: Player[], id: string | null) {
  if (!id) return 'BYE'
  return players.find(p => p.id === id)?.name || '?'
}

// Memo'd so incoming votes/reactions don't remount the iframe and restart playback
const SongEmbed = memo(function SongEmbed({ url, label }: { url: string; label: string }) {
  const [unmuted, setUnmuted] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const embed = getEmbedUrl(url)
  const isYoutube = /youtu/.test(url)

  function unmute() {
    setUnmuted(true)
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'unMute', args: [] }), '*')
      iframeRef.current.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'setVolume', args: [100] }), '*')
    }
  }

  if (!embed) return <a href={url} target="_blank" className="text-white/50 underline text-sm break-all">{url}</a>

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs tracking-[0.3em] text-white/40 uppercase">{label}</p>
      <div className="relative">
        <iframe
          ref={iframeRef}
          src={embed}
          className="w-full rounded-xl"
          height={isYoutube ? 200 : 152}
          allow="autoplay; clipboard-write; encrypted-media; fullscreen"
          allowFullScreen
        />
        {isYoutube && !unmuted && (
          <button
            onClick={unmute}
            className="absolute inset-0 flex items-end justify-center pb-4 rounded-xl"
            style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, transparent 55%)' }}
          >
            <span className="bg-white text-black font-bold text-sm px-6 py-2.5 rounded-full tracking-widest uppercase shadow-xl">
              Tap to Unmute
            </span>
          </button>
        )}
      </div>
      {!isYoutube && <p className="text-white/30 text-xs uppercase tracking-widest text-center">Press play above</p>}
    </div>
  )
})

export default function BracketPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [matches, setMatches] = useState<Match[]>([])
  const [players, setPlayers] = useState<Player[]>([])
  const [votes, setVotes] = useState<Vote[]>([])
  const [isHost, setIsHost] = useState(false)
  const [myPlayerId, setMyPlayerId] = useState('')
  const [judgeMode, setJudgeMode] = useState<'audience' | 'host'>('audience')
  const [mySong, setMySong] = useState('')
  const [myVote, setMyVote] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [finished, setFinished] = useState(false)

  // Feature state
  const [showIntro, setShowIntro] = useState(false)
  const [timeLeft, setTimeLeft] = useState<number | null>(null)
  const [timerPaused, setTimerPaused] = useState(false)
  const [reactions, setReactions] = useState<Reaction[]>([])
  const [winnerMessage, setWinnerMessage] = useState('')
  const [winnerMessageSaved, setWinnerMessageSaved] = useState<string | null>(null)

  const matchIdsRef = useRef<Set<string>>(new Set())
  const advancingRef = useRef(false)
  const introShownRef = useRef<string | null>(null)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const timerPausedRef = useRef(false)

  const allPending = matches.length > 0 && matches.every(m => m.status === 'pending')
  const currentMatch = allPending ? null : matches.find(m => m.status !== 'complete' && m.status !== 'pending')
  const maxRound = matches.length > 0 ? Math.max(...matches.map(m => m.round)) : 1

  const loadAll = useCallback(async () => {
    const [mRes, pRes, rRes] = await Promise.all([
      supabase.from('matches').select().eq('room_id', id).order('round').order('position'),
      supabase.from('players').select().eq('room_id', id),
      supabase.from('rooms').select('judge_mode, status, winner_message').eq('id', id).single(),
    ])
    if (mRes.data) {
      setMatches(mRes.data)
      matchIdsRef.current = new Set(mRes.data.map((m: Match) => m.id))
      const ids = mRes.data.map((m: Match) => m.id)
      if (ids.length) {
        const vRes = await supabase.from('votes').select().in('match_id', ids)
        if (vRes.data) setVotes(vRes.data)
      }
    }
    if (pRes.data) setPlayers(pRes.data)
    if (rRes.data) {
      setJudgeMode(rRes.data.judge_mode as 'audience' | 'host')
      if (rRes.data.status === 'finished') setFinished(true)
      if (rRes.data.winner_message) setWinnerMessageSaved(rRes.data.winner_message)
    }
  }, [id])

  function addReaction(emoji: string) {
    const rid = Date.now().toString() + Math.random()
    const x = Math.random() * 65 + 15
    setReactions(prev => [...prev, { id: rid, emoji, x }])
    setTimeout(() => setReactions(prev => prev.filter(r => r.id !== rid)), 2200)
  }

  function sendReaction(emoji: string) {
    channelRef.current?.send({ type: 'broadcast', event: 'reaction', payload: { emoji } })
  }

  useEffect(() => {
    const host = localStorage.getItem('isHost') === 'true'
    setIsHost(host)
    setMyPlayerId(localStorage.getItem('playerId') || '')
    loadAll()

    const ch = supabase
      .channel(`bracket-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matches', filter: `room_id=eq.${id}` }, (payload) => {
        setMatches(prev => prev.map(m => m.id === payload.new.id ? { ...m, ...payload.new } as Match : m))
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'matches', filter: `room_id=eq.${id}` }, (payload) => {
        setMatches(prev => {
          if (prev.find(m => m.id === payload.new.id)) return prev
          matchIdsRef.current.add(payload.new.id)
          return [...prev, payload.new as Match].sort((a, b) => a.round !== b.round ? a.round - b.round : a.position - b.position)
        })
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'votes' }, (payload) => {
        if (!matchIdsRef.current.has(payload.new.match_id)) return
        setVotes(prev => {
          const hasOptimistic = prev.find(v => v.voter_name === payload.new.voter_name && v.match_id === payload.new.match_id)
          if (hasOptimistic) return prev.map(v => v.voter_name === payload.new.voter_name && v.match_id === payload.new.match_id ? payload.new as Vote : v)
          return [...prev, payload.new as Vote]
        })
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'votes' }, (payload) => {
        if (!matchIdsRef.current.has(payload.new.match_id)) return
        setVotes(prev => prev.map(v => v.voter_name === payload.new.voter_name && v.match_id === payload.new.match_id ? payload.new as Vote : v))
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${id}` }, (payload) => {
        if (payload.new.status === 'finished') setFinished(true)
        if (payload.new.judge_mode) setJudgeMode(payload.new.judge_mode as 'audience' | 'host')
        if (payload.new.winner_message) setWinnerMessageSaved(payload.new.winner_message)
      })
      .on('broadcast', { event: 'reaction' }, ({ payload }) => {
        if (typeof payload?.emoji === 'string') addReaction(payload.emoji)
      })
      .subscribe()

    channelRef.current = ch

    const onVisible = () => { if (document.visibilityState === 'visible') loadAll() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      supabase.removeChannel(ch)
      channelRef.current = null
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [id, loadAll])

  // Restore vote state and clear song input when match changes
  useEffect(() => {
    setMySong('')
    if (!currentMatch) { setMyVote(null); return }
    const myName = players.find(p => p.id === myPlayerId)?.name
    if (!myName) { setMyVote(null); return }
    const existing = votes.find(v => v.match_id === currentMatch.id && v.voter_name === myName)
    setMyVote(existing?.voted_for ?? null)
  }, [currentMatch?.id, myPlayerId, players, votes])

  // Walk-up moment: show intro overlay when a real match starts (skip BYE)
  useEffect(() => {
    if (!currentMatch || currentMatch.status !== 'submitting') return
    if (currentMatch.player2_id === null) return // BYE match — skip intro
    if (introShownRef.current === currentMatch.id) return
    introShownRef.current = currentMatch.id
    setShowIntro(true)
    const t = setTimeout(() => setShowIntro(false), 3500)
    return () => clearTimeout(t)
  }, [currentMatch?.id, currentMatch?.status])

  // Song timer: 45s countdown per song; only song 2 auto-advances (song 1 just stops)
  useEffect(() => {
    // Reset pause state whenever the song or match changes
    timerPausedRef.current = false
    setTimerPaused(false)

    if (!currentMatch) { setTimeLeft(null); return }
    const playing = currentMatch.status === 'playing_p1' || currentMatch.status === 'playing_p2'
    if (!playing) { setTimeLeft(null); return }

    const matchId = currentMatch.id
    // Song 1 just stops at 0 — host manually advances to song 2
    // Song 2 auto-advances to voting when it runs out
    const autoAdvanceTo = currentMatch.status === 'playing_p2' ? 'voting' : null
    setTimeLeft(SONG_TIMER)

    const interval = setInterval(() => {
      if (timerPausedRef.current) return // paused — skip this tick
      setTimeLeft(prev => {
        if (prev === null) return null
        if (prev <= 1) {
          clearInterval(interval)
          if (autoAdvanceTo && localStorage.getItem('isHost') === 'true') {
            setMatches(m => m.map(match => match.id === matchId ? { ...match, status: autoAdvanceTo } : match))
            supabase.from('matches').update({ status: autoAdvanceTo }).eq('id', matchId)
          }
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [currentMatch?.id, currentMatch?.status])

  function toggleTimer() {
    const next = !timerPausedRef.current
    timerPausedRef.current = next
    setTimerPaused(next)
  }

  // Auto-advance BYE matches
  useEffect(() => {
    if (!isHost || !currentMatch) return
    if (currentMatch.player2_id === null && currentMatch.status === 'submitting') {
      const winnerId = currentMatch.player1_id!
      setMatches(prev => prev.map(m => m.id === currentMatch.id ? { ...m, winner_id: winnerId, status: 'revealing' } : m))
      supabase.from('matches').update({ winner_id: winnerId, status: 'revealing' }).eq('id', currentMatch.id)
    }
  }, [currentMatch?.id, currentMatch?.status, isHost])

  async function submitSong() {
    if (!mySong.trim() || !currentMatch || submitting) return
    setSubmitting(true)
    const isP1 = currentMatch.player1_id === myPlayerId
    const field = isP1 ? 'player1_song' : 'player2_song'
    const song = mySong.trim()
    setMatches(prev => prev.map(m => m.id === currentMatch.id ? { ...m, [field]: song } : m))
    setMySong('')
    setSubmitting(false)
    await supabase.from('matches').update({ [field]: song }).eq('id', currentMatch.id)
  }

  async function hostSet(newStatus: string) {
    if (!currentMatch) return
    setMatches(prev => prev.map(m => m.id === currentMatch.id ? { ...m, status: newStatus } : m))
    await supabase.from('matches').update({ status: newStatus }).eq('id', currentMatch.id)
  }

  async function castVote(votedFor: string) {
    if (!currentMatch || myVote) return
    const name = players.find(p => p.id === myPlayerId)?.name || 'Anon'
    setMyVote(votedFor)
    setVotes(prev => {
      const filtered = prev.filter(v => !(v.voter_name === name && v.match_id === currentMatch.id))
      return [...filtered, { id: 'opt-' + Date.now(), match_id: currentMatch.id, voter_name: name, voted_for: votedFor }]
    })
    await supabase.from('votes').upsert(
      { match_id: currentMatch.id, voter_name: name, voted_for: votedFor },
      { onConflict: 'match_id,voter_name' }
    )
  }

  async function decideWinner() {
    if (!currentMatch) return
    const matchVotes = votes.filter(v => v.match_id === currentMatch.id)
    const p1v = matchVotes.filter(v => v.voted_for === currentMatch.player1_id).length
    const p2v = matchVotes.filter(v => v.voted_for === currentMatch.player2_id).length
    const winnerId = currentMatch.player2_id === null
      ? currentMatch.player1_id!
      : p1v >= p2v ? currentMatch.player1_id! : currentMatch.player2_id!
    setMatches(prev => prev.map(m => m.id === currentMatch.id ? { ...m, winner_id: winnerId, status: 'revealing' } : m))
    await supabase.from('matches').update({ winner_id: winnerId, status: 'revealing' }).eq('id', currentMatch.id)
  }

  async function advanceMatch() {
    if (!currentMatch || advancingRef.current) return
    advancingRef.current = true
    try {
      const winnerId = currentMatch.winner_id!

      setMatches(prev => prev.map(m => m.id === currentMatch.id ? { ...m, status: 'complete' } : m))
      await supabase.from('matches').update({ status: 'complete' }).eq('id', currentMatch.id)

      const roundMatches = matches.filter(m => m.round === currentMatch.round)
      const nextInRound = roundMatches.find(m => m.position === currentMatch.position + 1 && m.status === 'pending')

      if (nextInRound) {
        setMatches(prev => prev.map(m => m.id === nextInRound.id ? { ...m, status: 'submitting' } : m))
        await supabase.from('matches').update({ status: 'submitting' }).eq('id', nextInRound.id)
      } else {
        const allRound = roundMatches.map(m => m.id === currentMatch.id ? { ...m, winner_id: winnerId } : m)
        const winners = allRound.map(m => m.winner_id).filter(Boolean) as string[]

        if (winners.length <= 1) {
          setFinished(true)
          await supabase.from('rooms').update({ status: 'finished' }).eq('id', id)
        } else {
          const nextRound = currentMatch.round + 1
          const nextMatches = []
          for (let i = 0; i < winners.length; i += 2) {
            nextMatches.push({
              room_id: id, round: nextRound, position: Math.floor(i / 2),
              player1_id: winners[i], player2_id: winners[i + 1] || null,
              status: i === 0 ? 'submitting' : 'pending',
            })
          }
          await supabase.from('matches').insert(nextMatches)
        }
      }
    } finally {
      advancingRef.current = false
    }
  }

  async function postWinnerMessage() {
    if (!winnerMessage.trim()) return
    const msg = winnerMessage.trim()
    setWinnerMessageSaved(msg)
    await supabase.from('rooms').update({ winner_message: msg }).eq('id', id)
  }

  // ── Champion screen ──────────────────────────────────────────────────────
  if (finished) {
    const lastCompleted = [...matches]
      .filter(m => m.status === 'complete' || m.status === 'revealing')
      .sort((a, b) => b.round - a.round || b.position - a.position)[0]
    const winner = players.find(p => p.id === lastCompleted?.winner_id)
    const iAmWinner = myPlayerId === lastCompleted?.winner_id

    return (
      <div className="min-h-screen relative flex flex-col items-center justify-center p-6 overflow-hidden">
        <div className="absolute inset-0 z-0" style={{ backgroundImage: 'url(/carti.jpg)', backgroundSize: 'cover', backgroundPosition: 'center top', filter: 'grayscale(20%) brightness(0.75)' }} />
        <div className="absolute inset-0 z-10" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.75) 100%)' }} />
        <div className="relative z-20 w-full max-w-sm flex flex-col items-center gap-6" style={{ animation: 'fadeIn 0.6s ease-out' }}>
          <div className="text-center">
            <p className="text-xs tracking-[0.3em] text-white/50 uppercase mb-4">AUX Battle Champion</p>
            <h1 className="text-7xl font-bold text-white leading-none">{winner?.name || '?'}</h1>
            <p className="text-white/40 text-sm mt-3 tracking-[0.2em] uppercase">has the best taste</p>
          </div>

          {/* Victory message */}
          {winnerMessageSaved ? (
            <p className="text-white/70 text-base italic text-center">"{winnerMessageSaved}"</p>
          ) : iAmWinner ? (
            <div className="flex flex-col gap-2 w-full">
              <input
                type="text"
                placeholder="Say something..."
                value={winnerMessage}
                maxLength={80}
                onChange={e => setWinnerMessage(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && postWinnerMessage()}
                autoFocus
                className="w-full py-3 px-4 bg-white/10 border border-white/20 text-white rounded-lg text-sm outline-none focus:border-white/50 placeholder:text-white/20 text-center transition-colors"
              />
              <button
                onClick={postWinnerMessage}
                disabled={!winnerMessage.trim()}
                className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg disabled:opacity-30 hover:bg-white/90 transition-colors"
              >
                Post
              </button>
            </div>
          ) : (
            <p className="text-white/25 text-xs uppercase tracking-widest">Waiting for winner's message...</p>
          )}

          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 border border-white/20 text-white/50 text-sm font-semibold tracking-widest uppercase rounded-lg hover:border-white/50 hover:text-white/80 transition-colors"
          >
            Back to Home
          </button>
        </div>
      </div>
    )
  }

  // ── Derived values ───────────────────────────────────────────────────────
  const isP1 = currentMatch?.player1_id === myPlayerId
  const isP2 = currentMatch?.player2_id === myPlayerId
  const isInMatch = isP1 || isP2
  const myAlreadySubmitted = isP1 ? !!currentMatch?.player1_song : isP2 ? !!currentMatch?.player2_song : false
  const matchVotes = votes.filter(v => v.match_id === currentMatch?.id)
  const p1Votes = matchVotes.filter(v => v.voted_for === currentMatch?.player1_id).length
  const p2Votes = matchVotes.filter(v => v.voted_for === currentMatch?.player2_id).length
  const totalVotes = p1Votes + p2Votes
  const p1Pct = totalVotes === 0 ? 50 : Math.round((p1Votes / totalVotes) * 100)
  const p2Pct = 100 - p1Pct
  const bothSubmitted = !!(currentMatch?.player1_song && currentMatch?.player2_song)
  const canVote = judgeMode === 'host' ? isHost : !isInMatch

  const roundMatchesForCurrent = currentMatch ? matches.filter(m => m.round === currentMatch.round) : []
  const hasMoreInRound = currentMatch
    ? roundMatchesForCurrent.some(m => m.position > currentMatch.position && m.status === 'pending')
    : false
  // One match left in this round means only 1 winner → tournament is over
  const isFinalMatch = !hasMoreInRound && roundMatchesForCurrent.length === 1

  const timerPct = timeLeft !== null ? (timeLeft / SONG_TIMER) * 100 : 100

  return (
    <>
      {/* Floating reactions overlay */}
      {reactions.map(r => (
        <div
          key={r.id}
          className="fixed bottom-28 pointer-events-none z-50 text-4xl select-none"
          style={{ left: `${r.x}%`, animation: 'floatUp 2.2s ease-out forwards' }}
        >
          {r.emoji}
        </div>
      ))}

      {/* Walk-up intro overlay */}
      {showIntro && currentMatch && (
        <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-black/95 backdrop-blur-md" style={{ animation: 'fadeIn 0.3s ease-out' }}>
          <p className="text-xs tracking-[0.4em] text-white/40 uppercase mb-8">Next Up</p>
          <div className="flex items-center gap-8">
            <span className="text-4xl font-bold text-white">{pName(players, currentMatch.player1_id)}</span>
            <span className="text-white/25 text-2xl font-light">vs</span>
            <span className="text-4xl font-bold text-white">{pName(players, currentMatch.player2_id)}</span>
          </div>
          <p className="text-white/20 text-xs mt-10 uppercase tracking-[0.3em]">Round {currentMatch.round}</p>
        </div>
      )}

      <div className="min-h-screen relative flex flex-col p-4 pb-10 overflow-hidden">
        <div className="absolute inset-0 z-0" style={{ backgroundImage: 'url(/carti.jpg)', backgroundSize: 'cover', backgroundPosition: 'center top', filter: 'grayscale(20%) brightness(0.75)' }} />
        <div className="absolute inset-0 z-10" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.65) 100%)' }} />

        <div className="relative z-20 w-full max-w-lg mx-auto flex flex-col gap-6 pt-6">

          {/* Header */}
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs tracking-[0.3em] text-white/40 uppercase mb-1">
                {allPending ? 'The Bracket' : `Round ${currentMatch?.round ?? maxRound}`}
              </p>
              <h1 className="text-4xl font-bold text-white leading-none">AUX BATTLE</h1>
            </div>
            <button onClick={() => router.push('/')} className="text-white/30 text-xs tracking-widest uppercase hover:text-white/60 transition-colors">Leave</button>
          </div>

          {/* Bracket reveal */}
          {allPending && (
            <div className="bg-black/40 backdrop-blur-sm rounded-2xl p-5 border border-white/10 flex flex-col gap-4">
              <p className="text-xs tracking-[0.3em] text-white/50 uppercase">Round 1 Matchups</p>
              {matches.filter(m => m.round === 1).map(match => (
                <div key={match.id} className="flex items-center justify-between py-3 border-b border-white/10 last:border-0">
                  <span className="text-white font-semibold">{pName(players, match.player1_id)}</span>
                  <span className="text-white/30 text-xs px-3">vs</span>
                  <span className="text-white font-semibold">{pName(players, match.player2_id)}</span>
                  {match.player2_id === null && <span className="text-white/20 text-xs ml-2">auto-advance</span>}
                </div>
              ))}
              {isHost ? (
                <button
                  onClick={async () => {
                    const first = matches.find(m => m.round === 1 && m.position === 0)
                    if (!first) return
                    setMatches(prev => prev.map(m => m.id === first.id ? { ...m, status: 'submitting' } : m))
                    await supabase.from('matches').update({ status: 'submitting' }).eq('id', first.id)
                  }}
                  className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 transition-colors mt-2"
                >
                  Start Match 1 →
                </button>
              ) : (
                <p className="text-white/30 text-xs tracking-widest uppercase text-center">Waiting for host to start...</p>
              )}
            </div>
          )}

          {/* Active match card */}
          {currentMatch && (
            <div className="bg-black/40 backdrop-blur-sm rounded-2xl p-5 border border-white/10 flex flex-col gap-5">

              {/* Match header */}
              <div className="flex items-center justify-between">
                <span className="text-white font-bold text-lg">{pName(players, currentMatch.player1_id)}</span>
                <span className="text-white/30 text-sm">vs</span>
                <span className="text-white font-bold text-lg">{pName(players, currentMatch.player2_id)}</span>
              </div>

              {/* SUBMITTING */}
              {currentMatch.status === 'submitting' && (
                <div className="flex flex-col gap-3">
                  {isInMatch && !myAlreadySubmitted ? (
                    <>
                      <p className="text-white/40 text-xs uppercase tracking-widest">Pick your song</p>
                      <input
                        type="text"
                        placeholder="Paste a YouTube or Spotify link"
                        value={mySong}
                        onChange={e => setMySong(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && submitSong()}
                        className="w-full py-3 px-4 bg-white/10 border border-white/20 text-white rounded-lg text-sm outline-none focus:border-white/50 placeholder:text-white/25 transition-colors"
                      />
                      <button onClick={submitSong} disabled={submitting || !mySong.trim()} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 disabled:opacity-40 transition-colors">
                        {submitting ? 'Locking In...' : 'Submit Song'}
                      </button>
                    </>
                  ) : isInMatch && myAlreadySubmitted ? (
                    <p className="text-white/40 text-xs uppercase tracking-widest">Locked in — waiting for opponent...</p>
                  ) : bothSubmitted ? (
                    <p className="text-white/40 text-xs uppercase tracking-widest">Both songs in — waiting for host...</p>
                  ) : (
                    <p className="text-white/40 text-xs uppercase tracking-widest">
                      Waiting for {!currentMatch.player1_song ? pName(players, currentMatch.player1_id) : pName(players, currentMatch.player2_id)} to submit...
                    </p>
                  )}
                  {isHost && bothSubmitted && (
                    <button onClick={() => hostSet('playing_p1')} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 transition-colors">
                      Both In — Play Song 1 →
                    </button>
                  )}
                </div>
              )}

              {/* PLAYING SONG 1 */}
              {currentMatch.status === 'playing_p1' && currentMatch.player1_song && (
                <div className="flex flex-col gap-4">
                  <SongEmbed url={currentMatch.player1_song} label={`${pName(players, currentMatch.player1_id)}'s Song`} />

                  {/* Timer bar */}
                  {timeLeft !== null && (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between items-center">
                        <p className="text-white/30 text-xs uppercase tracking-widest">
                          {timerPaused ? 'Paused' : timeLeft === 0 ? 'Song done' : 'Time left'}
                        </p>
                        <p className={`font-bold tabular-nums text-sm ${timeLeft <= 10 && !timerPaused ? 'text-red-400' : 'text-white/60'}`}>
                          {timeLeft}s
                        </p>
                      </div>
                      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-1000 linear"
                          style={{ width: `${timerPct}%`, backgroundColor: timerPaused ? '#6b7280' : timeLeft <= 10 ? '#f87171' : 'white' }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Reaction buttons */}
                  <div className="flex justify-center gap-5">
                    {['🔥', '💀', '💯', '😤'].map(emoji => (
                      <button key={emoji} onClick={() => sendReaction(emoji)} className="text-2xl active:scale-125 transition-transform select-none">
                        {emoji}
                      </button>
                    ))}
                  </div>

                  {/* Song 1 done — waiting for host to start song 2 */}
                  {timeLeft === 0 && !isHost && (
                    <p className="text-white/30 text-xs uppercase tracking-widest text-center">Waiting for host to play song 2...</p>
                  )}

                  {isHost && (
                    <div className="flex flex-col gap-2">
                      {timeLeft !== null && timeLeft > 0 && (
                        <button onClick={toggleTimer} className="w-full py-2 border border-white/20 text-white/50 text-xs font-semibold tracking-widest uppercase rounded-lg hover:border-white/40 hover:text-white/70 transition-colors">
                          {timerPaused ? '▶  Resume Timer' : '⏸  Pause Timer'}
                        </button>
                      )}
                      <button onClick={() => hostSet('playing_p2')} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 transition-colors">
                        {timeLeft === 0 ? 'Play Song 2 →' : 'Skip — Play Song 2 →'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* PLAYING SONG 2 */}
              {currentMatch.status === 'playing_p2' && currentMatch.player2_song && (
                <div className="flex flex-col gap-4">
                  <SongEmbed url={currentMatch.player2_song} label={`${pName(players, currentMatch.player2_id)}'s Song`} />

                  {/* Timer bar */}
                  {timeLeft !== null && (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between items-center">
                        <p className="text-white/30 text-xs uppercase tracking-widest">
                          {timerPaused ? 'Paused' : 'Time left'}
                        </p>
                        <p className={`font-bold tabular-nums text-sm ${timeLeft <= 10 && !timerPaused ? 'text-red-400' : 'text-white/60'}`}>
                          {timeLeft}s
                        </p>
                      </div>
                      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-1000 linear"
                          style={{ width: `${timerPct}%`, backgroundColor: timerPaused ? '#6b7280' : timeLeft <= 10 ? '#f87171' : 'white' }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Reaction buttons */}
                  <div className="flex justify-center gap-5">
                    {['🔥', '💀', '💯', '😤'].map(emoji => (
                      <button key={emoji} onClick={() => sendReaction(emoji)} className="text-2xl active:scale-125 transition-transform select-none">
                        {emoji}
                      </button>
                    ))}
                  </div>

                  {isHost && (
                    <div className="flex flex-col gap-2">
                      {timeLeft !== null && timeLeft > 0 && (
                        <button onClick={toggleTimer} className="w-full py-2 border border-white/20 text-white/50 text-xs font-semibold tracking-widest uppercase rounded-lg hover:border-white/40 hover:text-white/70 transition-colors">
                          {timerPaused ? '▶  Resume Timer' : '⏸  Pause Timer'}
                        </button>
                      )}
                      <button onClick={() => hostSet('voting')} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 transition-colors">
                        Open Voting →
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* VOTING */}
              {currentMatch.status === 'voting' && (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <p className="text-white/40 text-xs uppercase tracking-widest">
                      {judgeMode === 'host' ? 'Host is deciding...' : 'Vote for your favorite'}
                    </p>
                    <p className="text-white/25 text-xs">{totalVotes} vote{totalVotes !== 1 ? 's' : ''}</p>
                  </div>

                  {/* Vote buttons */}
                  {canVote && !myVote && (
                    <div className="flex gap-3">
                      <button onClick={() => castVote(currentMatch.player1_id!)} className="flex-1 py-4 bg-white/10 border border-white/20 text-white font-semibold text-sm rounded-xl hover:bg-white/20 active:scale-95 transition-all">
                        {pName(players, currentMatch.player1_id)}
                      </button>
                      <button onClick={() => castVote(currentMatch.player2_id!)} className="flex-1 py-4 bg-white/10 border border-white/20 text-white font-semibold text-sm rounded-xl hover:bg-white/20 active:scale-95 transition-all">
                        {pName(players, currentMatch.player2_id)}
                      </button>
                    </div>
                  )}

                  {/* Animated vote bar — visible to all once someone has voted or you can't vote */}
                  {(myVote || !canVote) && (
                    <div className="flex flex-col gap-2">
                      <div className="flex justify-between text-xs text-white/40 uppercase tracking-wide">
                        <span>{pName(players, currentMatch.player1_id)}</span>
                        <span>{pName(players, currentMatch.player2_id)}</span>
                      </div>
                      <div className="flex h-2 bg-white/10 rounded-full overflow-hidden">
                        <div className="bg-white rounded-full transition-all duration-700 ease-out" style={{ width: `${p1Pct}%` }} />
                      </div>
                      <div className="flex justify-between text-white font-bold text-xl">
                        <span>{p1Votes}</span>
                        <span className="text-white/25 text-xs self-center">{p1Pct}% — {p2Pct}%</span>
                        <span>{p2Votes}</span>
                      </div>
                    </div>
                  )}

                  {canVote && myVote && <p className="text-white/30 text-xs uppercase tracking-widest text-center">Locked in ✓</p>}
                  {!canVote && isInMatch && <p className="text-white/30 text-xs uppercase tracking-widest">You're competing — sit tight</p>}
                  {!canVote && !isInMatch && judgeMode === 'host' && <p className="text-white/30 text-xs uppercase tracking-widest">Host is deciding...</p>}

                  {isHost && (
                    <button onClick={decideWinner} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 transition-colors">
                      Decide Winner →
                    </button>
                  )}
                </div>
              )}

              {/* REVEALING — match winner screen */}
              {currentMatch.status === 'revealing' && (
                <div className="flex flex-col items-center gap-5" style={{ animation: 'fadeIn 0.4s ease-out' }}>
                  <div className="text-center py-2">
                    <p className="text-xs tracking-[0.3em] text-white/40 uppercase mb-3">Match Winner</p>
                    <p className="text-5xl font-bold text-white">{pName(players, currentMatch.winner_id)}</p>
                    {judgeMode === 'host' && <p className="text-white/30 text-xs mt-2 uppercase tracking-widest">Host's pick</p>}
                  </div>

                  {/* Final vote bar */}
                  {currentMatch.player2_id !== null && totalVotes > 0 && (
                    <div className="flex flex-col gap-2 w-full">
                      <div className="flex justify-between text-xs text-white/40 uppercase tracking-wide">
                        <span>{pName(players, currentMatch.player1_id)}</span>
                        <span>{pName(players, currentMatch.player2_id)}</span>
                      </div>
                      <div className="flex h-2 bg-white/10 rounded-full overflow-hidden">
                        <div className="bg-white rounded-full" style={{ width: `${p1Pct}%` }} />
                      </div>
                      <div className="flex justify-between text-white font-bold text-xl">
                        <span className={currentMatch.winner_id === currentMatch.player1_id ? 'text-white' : 'text-white/40'}>{p1Votes}</span>
                        <span className="text-white/25 text-xs self-center">{p1Pct}% — {p2Pct}%</span>
                        <span className={currentMatch.winner_id === currentMatch.player2_id ? 'text-white' : 'text-white/40'}>{p2Votes}</span>
                      </div>
                    </div>
                  )}

                  {isHost ? (
                    <button onClick={advanceMatch} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 transition-colors">
                      {hasMoreInRound ? 'Next Match →' : isFinalMatch ? 'Crown Champion →' : 'Start Next Round →'}
                    </button>
                  ) : (
                    <p className="text-white/30 text-xs uppercase tracking-widest">Waiting for host...</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Full bracket overview */}
          <div className="flex flex-col gap-5">
            {Array.from({ length: maxRound }, (_, i) => i + 1).map(round => (
              <div key={round}>
                <p className="text-xs tracking-[0.3em] text-white/30 uppercase mb-2">Round {round}</p>
                <div className="flex flex-col gap-2">
                  {matches.filter(m => m.round === round).map(match => {
                    const isActive = match.id === currentMatch?.id
                    const isDone = match.status === 'complete' || match.status === 'revealing'
                    return (
                      <div key={match.id} className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-colors ${isActive ? 'border-white/40 bg-white/10' : 'border-white/10 bg-white/5'}`}>
                        <span className={`text-sm ${isDone && match.winner_id === match.player1_id ? 'text-white font-semibold' : isActive ? 'text-white/80' : 'text-white/40'}`}>
                          {pName(players, match.player1_id)}
                        </span>
                        <span className="text-white/20 text-xs">vs</span>
                        <span className={`text-sm ${isDone && match.winner_id === match.player2_id ? 'text-white font-semibold' : isActive ? 'text-white/80' : 'text-white/40'}`}>
                          {pName(players, match.player2_id)}
                        </span>
                        {isDone && <span className="text-white/30 text-xs ml-2">✓</span>}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

        </div>
      </div>
    </>
  )
}
