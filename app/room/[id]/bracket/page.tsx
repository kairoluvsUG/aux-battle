'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
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

function getEmbedUrl(url: string) {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  if (yt) return `https://www.youtube.com/embed/${yt[1]}?autoplay=1&controls=1&rel=0&modestbranding=1`
  const sp = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/)
  if (sp) return `https://open.spotify.com/embed/${sp[1]}/${sp[2]}`
  return null
}

function pName(players: Player[], id: string | null) {
  if (!id) return 'BYE'
  return players.find(p => p.id === id)?.name || '?'
}

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
  const matchIdsRef = useRef<Set<string>>(new Set())
  const advancingRef = useRef(false)

  const allPending = matches.length > 0 && matches.every(m => m.status === 'pending')
  const currentMatch = allPending ? null : matches.find(m => m.status !== 'complete' && m.status !== 'pending')
  const maxRound = matches.length > 0 ? Math.max(...matches.map(m => m.round)) : 1

  const loadAll = useCallback(async () => {
    const [mRes, pRes, rRes] = await Promise.all([
      supabase.from('matches').select().eq('room_id', id).order('round').order('position'),
      supabase.from('players').select().eq('room_id', id),
      supabase.from('rooms').select('judge_mode, status').eq('id', id).single(),
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
    }
  }, [id])

  useEffect(() => {
    const host = localStorage.getItem('isHost') === 'true'
    setIsHost(host)
    setMyPlayerId(localStorage.getItem('playerId') || '')
    loadAll()

    const sub = supabase
      .channel(`bracket-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matches', filter: `room_id=eq.${id}` }, (payload) => {
        setMatches(prev => prev.map(m => m.id === payload.new.id ? { ...m, ...payload.new } as Match : m))
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'matches', filter: `room_id=eq.${id}` }, (payload) => {
        setMatches(prev => {
          if (prev.find(m => m.id === payload.new.id)) return prev
          matchIdsRef.current.add(payload.new.id)
          const next = [...prev, payload.new as Match]
          return next.sort((a, b) => a.round !== b.round ? a.round - b.round : a.position - b.position)
        })
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'votes' }, (payload) => {
        if (!matchIdsRef.current.has(payload.new.match_id)) return
        setVotes(prev => {
          // Replace optimistic entry (same voter + match) with the real DB row to prevent double-counting
          const hasOptimistic = prev.find(v => v.voter_name === payload.new.voter_name && v.match_id === payload.new.match_id)
          if (hasOptimistic) {
            return prev.map(v =>
              v.voter_name === payload.new.voter_name && v.match_id === payload.new.match_id
                ? payload.new as Vote
                : v
            )
          }
          return [...prev, payload.new as Vote]
        })
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'votes' }, (payload) => {
        if (!matchIdsRef.current.has(payload.new.match_id)) return
        setVotes(prev => prev.map(v =>
          v.voter_name === payload.new.voter_name && v.match_id === payload.new.match_id
            ? payload.new as Vote
            : v
        ))
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${id}` }, (payload) => {
        if (payload.new.status === 'finished') setFinished(true)
        if (payload.new.judge_mode) setJudgeMode(payload.new.judge_mode as 'audience' | 'host')
      })
      .subscribe()

    const onVisible = () => { if (document.visibilityState === 'visible') loadAll() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      supabase.removeChannel(sub)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [id, loadAll])

  // Reset vote state when match changes; restore from loaded votes
  useEffect(() => {
    if (!currentMatch) { setMyVote(null); return }
    const myName = players.find(p => p.id === myPlayerId)?.name
    if (!myName) { setMyVote(null); return }
    const existing = votes.find(v => v.match_id === currentMatch.id && v.voter_name === myName)
    setMyVote(existing?.voted_for ?? null)
  }, [currentMatch?.id, myPlayerId, players, votes])

  // Auto-advance BYE matches (host only, runs once per match)
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
    // Upsert optimistic entry — keyed by voter_name+match_id, not id
    setVotes(prev => {
      const filtered = prev.filter(v => !(v.voter_name === name && v.match_id === currentMatch.id))
      return [...filtered, { id: 'opt-' + Date.now(), match_id: currentMatch.id, voter_name: name, voted_for: votedFor }]
    })
    await supabase.from('votes').upsert(
      { match_id: currentMatch.id, voter_name: name, voted_for: votedFor },
      { onConflict: 'match_id,voter_name' }
    )
  }

  // Called when host clicks "Decide Winner" — reveals result, stays on the match
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

  // Called when host clicks "Next" after the winner reveal
  async function advanceMatch() {
    if (!currentMatch || advancingRef.current) return
    advancingRef.current = true
    const winnerId = currentMatch.winner_id!

    setMatches(prev => prev.map(m => m.id === currentMatch.id ? { ...m, status: 'complete' } : m))
    await supabase.from('matches').update({ status: 'complete' }).eq('id', currentMatch.id)

    const roundMatches = matches.filter(m => m.round === currentMatch.round)
    const nextInRound = roundMatches.find(m => m.position === currentMatch.position + 1 && m.status === 'pending')

    if (nextInRound) {
      setMatches(prev => prev.map(m => m.id === nextInRound.id ? { ...m, status: 'submitting' } : m))
      await supabase.from('matches').update({ status: 'submitting' }).eq('id', nextInRound.id)
    } else {
      // This was the last match in the round — collect all winners
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

    advancingRef.current = false
  }

  // Tournament champion screen
  if (finished) {
    const lastCompleted = [...matches]
      .filter(m => m.status === 'complete' || m.status === 'revealing')
      .sort((a, b) => b.round - a.round || b.position - a.position)[0]
    const winner = players.find(p => p.id === lastCompleted?.winner_id)
    return (
      <div className="min-h-screen relative flex flex-col items-center justify-center p-6 overflow-hidden">
        <div className="absolute inset-0 z-0" style={{ backgroundImage: 'url(/carti.jpg)', backgroundSize: 'cover', backgroundPosition: 'center top', filter: 'grayscale(20%) brightness(0.75)' }} />
        <div className="absolute inset-0 z-10" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.7) 100%)' }} />
        <div className="relative z-20 text-center flex flex-col gap-6">
          <div>
            <p className="text-xs tracking-[0.3em] text-white/50 uppercase mb-4">AUX Battle Champion</p>
            <h1 className="text-7xl font-bold text-white leading-none">{winner?.name || '?'}</h1>
            <p className="text-white/40 text-sm mt-4 tracking-[0.2em] uppercase">has the best taste</p>
          </div>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 border border-white/30 text-white/60 text-sm font-semibold tracking-widest uppercase rounded-lg hover:border-white/60 hover:text-white transition-colors"
          >
            Back to Home
          </button>
        </div>
      </div>
    )
  }

  const isP1 = currentMatch?.player1_id === myPlayerId
  const isP2 = currentMatch?.player2_id === myPlayerId
  const isInMatch = isP1 || isP2
  const myAlreadySubmitted = isP1 ? !!currentMatch?.player1_song : isP2 ? !!currentMatch?.player2_song : false
  const matchVotes = votes.filter(v => v.match_id === currentMatch?.id)
  const p1Votes = matchVotes.filter(v => v.voted_for === currentMatch?.player1_id).length
  const p2Votes = matchVotes.filter(v => v.voted_for === currentMatch?.player2_id).length
  const totalVotes = p1Votes + p2Votes
  const bothSubmitted = !!(currentMatch?.player1_song && currentMatch?.player2_song)
  const canVote = judgeMode === 'host' ? isHost : !isInMatch

  // Determine next-button label for the revealing state
  const roundMatchesForCurrent = currentMatch ? matches.filter(m => m.round === currentMatch.round) : []
  const hasMoreInRound = currentMatch
    ? roundMatchesForCurrent.some(m => m.position > currentMatch.position && m.status === 'pending')
    : false
  const revealButtonLabel = hasMoreInRound ? 'Next Match →' : 'Start Next Round →'

  function renderEmbed(url: string | null, label: string) {
    if (!url) return null
    const embed = getEmbedUrl(url)
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs tracking-[0.3em] text-white/40 uppercase">{label}</p>
        {embed
          ? <iframe src={embed} className="w-full rounded-xl" height={url.includes('spotify') ? 152 : 180} allow="autoplay; clipboard-write; encrypted-media; fullscreen" allowFullScreen />
          : <a href={url} target="_blank" className="text-white/50 underline text-sm break-all">{url}</a>
        }
      </div>
    )
  }

  return (
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

        {/* Bracket reveal — all pending, host hasn't started yet */}
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

            {/* Players header */}
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
            {currentMatch.status === 'playing_p1' && (
              <div className="flex flex-col gap-4">
                {renderEmbed(currentMatch.player1_song, `${pName(players, currentMatch.player1_id)}'s Song`)}
                {isHost && (
                  <button onClick={() => hostSet('playing_p2')} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 transition-colors">
                    Next — Play Song 2 →
                  </button>
                )}
              </div>
            )}

            {/* PLAYING SONG 2 */}
            {currentMatch.status === 'playing_p2' && (
              <div className="flex flex-col gap-4">
                {renderEmbed(currentMatch.player2_song, `${pName(players, currentMatch.player2_id)}'s Song`)}
                {isHost && (
                  <button onClick={() => hostSet('voting')} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 transition-colors">
                    Open Voting →
                  </button>
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

                {/* Vote buttons — only for eligible voters who haven't voted */}
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

                {/* Live vote tally — visible after voting, and always to non-voters */}
                {(myVote || !canVote) && (
                  <div className="flex gap-3">
                    <div className={`flex-1 text-center py-4 rounded-xl border transition-colors ${myVote === currentMatch.player1_id ? 'border-white/50 bg-white/10' : 'border-white/10 bg-white/5'}`}>
                      <p className="text-white font-bold text-3xl">{p1Votes}</p>
                      <p className="text-white/40 text-xs mt-1">{pName(players, currentMatch.player1_id)}</p>
                    </div>
                    <div className={`flex-1 text-center py-4 rounded-xl border transition-colors ${myVote === currentMatch.player2_id ? 'border-white/50 bg-white/10' : 'border-white/10 bg-white/5'}`}>
                      <p className="text-white font-bold text-3xl">{p2Votes}</p>
                      <p className="text-white/40 text-xs mt-1">{pName(players, currentMatch.player2_id)}</p>
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
              <div className="flex flex-col items-center gap-5">
                <div className="text-center py-2">
                  <p className="text-xs tracking-[0.3em] text-white/40 uppercase mb-3">Match Winner</p>
                  <p className="text-5xl font-bold text-white">{pName(players, currentMatch.winner_id)}</p>
                  {judgeMode === 'host' && <p className="text-white/30 text-xs mt-2 uppercase tracking-widest">Host's pick</p>}
                </div>

                {/* Final vote tally */}
                {currentMatch.player2_id !== null && (
                  <div className="flex gap-3 w-full">
                    <div className={`flex-1 text-center py-4 rounded-xl border ${currentMatch.winner_id === currentMatch.player1_id ? 'border-white/60 bg-white/15' : 'border-white/10 bg-white/5'}`}>
                      <p className="text-white font-bold text-3xl">{p1Votes}</p>
                      <p className={`text-xs mt-1 ${currentMatch.winner_id === currentMatch.player1_id ? 'text-white/60' : 'text-white/30'}`}>
                        {pName(players, currentMatch.player1_id)}
                      </p>
                    </div>
                    <div className={`flex-1 text-center py-4 rounded-xl border ${currentMatch.winner_id === currentMatch.player2_id ? 'border-white/60 bg-white/15' : 'border-white/10 bg-white/5'}`}>
                      <p className="text-white font-bold text-3xl">{p2Votes}</p>
                      <p className={`text-xs mt-1 ${currentMatch.winner_id === currentMatch.player2_id ? 'text-white/60' : 'text-white/30'}`}>
                        {pName(players, currentMatch.player2_id)}
                      </p>
                    </div>
                  </div>
                )}

                {isHost ? (
                  <button onClick={advanceMatch} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 transition-colors">
                    {revealButtonLabel}
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
  )
}
