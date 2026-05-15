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
    setIsHost(localStorage.getItem('isHost') === 'true')
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
          return [...prev, payload.new as Match]
        })
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'votes' }, (payload) => {
        // Only add votes that belong to this room's matches
        if (!matchIdsRef.current.has(payload.new.match_id)) return
        setVotes(prev => {
          if (prev.find(v => v.id === payload.new.id)) return prev
          return [...prev, payload.new as Vote]
        })
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${id}` }, (payload) => {
        if (payload.new.status === 'finished') setFinished(true)
        if (payload.new.judge_mode) setJudgeMode(payload.new.judge_mode as 'audience' | 'host')
      })
      .subscribe()

    // Refetch when tab becomes visible
    const onVisible = () => { if (document.visibilityState === 'visible') loadAll() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      supabase.removeChannel(sub)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [id, loadAll])

  // Restore voted state when match changes or votes load
  useEffect(() => {
    if (!currentMatch || !players.length) return
    const myName = players.find(p => p.id === myPlayerId)?.name
    if (!myName) return
    const existing = votes.find(v => v.match_id === currentMatch.id && v.voter_name === myName)
    setMyVote(existing ? existing.voted_for : null)
  }, [currentMatch?.id, votes, myPlayerId, players])

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
    setVotes(prev => [...prev, { id: 'opt-' + Date.now(), match_id: currentMatch.id, voter_name: name, voted_for: votedFor }])
    await supabase.from('votes').upsert({ match_id: currentMatch.id, voter_name: name, voted_for: votedFor }, { onConflict: 'match_id,voter_name' })
  }

  async function finishMatch() {
    if (!currentMatch) return
    const matchVotes = votes.filter(v => v.match_id === currentMatch.id)
    const p1v = matchVotes.filter(v => v.voted_for === currentMatch.player1_id).length
    const p2v = matchVotes.filter(v => v.voted_for === currentMatch.player2_id).length
    const winnerId = p1v >= p2v ? currentMatch.player1_id! : currentMatch.player2_id!

    // Optimistic update
    setMatches(prev => prev.map(m => m.id === currentMatch.id ? { ...m, winner_id: winnerId, status: 'complete' } : m))
    await supabase.from('matches').update({ winner_id: winnerId, status: 'complete' }).eq('id', currentMatch.id)

    const roundMatches = matches.filter(m => m.round === currentMatch.round)
    const nextInRound = roundMatches.find(m => m.position === currentMatch.position + 1 && m.status === 'pending')

    if (nextInRound) {
      setMatches(prev => prev.map(m => m.id === nextInRound.id ? { ...m, status: 'submitting' } : m))
      await supabase.from('matches').update({ status: 'submitting' }).eq('id', nextInRound.id)
    } else {
      const allRoundWithWinner = roundMatches.map(m =>
        m.id === currentMatch.id ? { ...m, winner_id: winnerId } : m
      )
      const winners = allRoundWithWinner.map(m => m.winner_id).filter(Boolean) as string[]

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
  }

  // Winner screen
  if (finished) {
    const lastCompleted = [...matches].filter(m => m.status === 'complete').sort((a, b) => b.round - a.round)[0]
    const winner = players.find(p => p.id === lastCompleted?.winner_id)
    return (
      <div className="min-h-screen relative flex flex-col items-center justify-center p-6 overflow-hidden">
        <div className="absolute inset-0 z-0" style={{ backgroundImage: 'url(/carti.jpg)', backgroundSize: 'cover', backgroundPosition: 'center top', filter: 'grayscale(20%) brightness(0.75)' }} />
        <div className="absolute inset-0 z-10" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.6) 100%)' }} />
        <div className="relative z-20 text-center flex flex-col gap-6">
          <div>
            <p className="text-xs tracking-[0.3em] text-white/50 uppercase mb-2">AUX Battle Winner</p>
            <h1 className="text-7xl font-bold text-white leading-none">{winner?.name || '?'}</h1>
          </div>
          <button onClick={() => router.push('/')} className="px-6 py-3 border border-white/30 text-white/60 text-sm font-semibold tracking-widest uppercase rounded-lg hover:border-white/60 hover:text-white transition-colors">
            Back to Home
          </button>
        </div>
      </div>
    )
  }

  const isP1 = currentMatch?.player1_id === myPlayerId
  const isP2 = currentMatch?.player2_id === myPlayerId
  const isInMatch = isP1 || isP2
  const myAlreadySubmitted = currentMatch ? (isP1 ? !!currentMatch.player1_song : isP2 ? !!currentMatch.player2_song : false) : false
  const matchVotes = votes.filter(v => v.match_id === currentMatch?.id)
  const p1Votes = matchVotes.filter(v => v.voted_for === currentMatch?.player1_id).length
  const p2Votes = matchVotes.filter(v => v.voted_for === currentMatch?.player2_id).length
  const bothSubmitted = !!(currentMatch?.player1_song && currentMatch?.player2_song)
  // Who can vote: host mode = only host, audience mode = everyone except the two competing
  const canVote = judgeMode === 'host' ? isHost : !isInMatch

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
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs tracking-[0.3em] text-white/40 uppercase mb-1">
              {allPending ? 'The Bracket' : `Round ${currentMatch?.round ?? maxRound}`}
            </p>
            <h1 className="text-4xl font-bold text-white leading-none">AUX BATTLE</h1>
          </div>
          <button onClick={() => router.push('/')} className="text-white/30 text-xs tracking-widest uppercase hover:text-white/60 transition-colors">Leave</button>
        </div>

        {/* Bracket reveal — shown before any match starts */}
        {allPending && (
          <div className="bg-black/40 backdrop-blur-sm rounded-2xl p-5 border border-white/10 flex flex-col gap-4">
            <p className="text-xs tracking-[0.3em] text-white/50 uppercase">Round 1 Matchups</p>
            {matches.filter(m => m.round === 1).map((match, i) => (
              <div key={match.id} className="flex items-center justify-between py-3 border-b border-white/10 last:border-0">
                <span className="text-white font-semibold">{pName(players, match.player1_id)}</span>
                <span className="text-white/30 text-xs px-3">vs</span>
                <span className="text-white font-semibold">{pName(players, match.player2_id)}</span>
                {match.player2_id === null && (
                  <span className="text-white/20 text-xs ml-2">auto-advance</span>
                )}
              </div>
            ))}
            {isHost && (
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
            )}
            {!isHost && (
              <p className="text-white/30 text-xs tracking-widest uppercase text-center">Waiting for host to start...</p>
            )}
          </div>
        )}

        {currentMatch && (
          <div className="bg-black/40 backdrop-blur-sm rounded-2xl p-5 border border-white/10 flex flex-col gap-5">
            <div className="flex items-center justify-between">
              <span className="text-white font-bold text-lg">{pName(players, currentMatch.player1_id)}</span>
              <span className="text-white/30 text-sm">vs</span>
              <span className="text-white font-bold text-lg">{pName(players, currentMatch.player2_id)}</span>
            </div>

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
                ) : (
                  <p className="text-white/40 text-xs uppercase tracking-widest">
                    Waiting for {!currentMatch.player1_song ? pName(players, currentMatch.player1_id) : pName(players, currentMatch.player2_id)} to submit...
                  </p>
                )}
                {isHost && bothSubmitted && (
                  <button onClick={() => hostSet('playing_p1')} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg">
                    Both In — Play Song 1 →
                  </button>
                )}
              </div>
            )}

            {currentMatch.status === 'playing_p1' && (
              <div className="flex flex-col gap-4">
                {renderEmbed(currentMatch.player1_song, `${pName(players, currentMatch.player1_id)}'s Song`)}
                {isHost && <button onClick={() => hostSet('playing_p2')} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg">Next — Play Song 2 →</button>}
              </div>
            )}

            {currentMatch.status === 'playing_p2' && (
              <div className="flex flex-col gap-4">
                {renderEmbed(currentMatch.player2_song, `${pName(players, currentMatch.player2_id)}'s Song`)}
                {isHost && <button onClick={() => hostSet('voting')} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg">Open Voting →</button>}
              </div>
            )}

            {currentMatch.status === 'voting' && (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <p className="text-white/40 text-xs uppercase tracking-widest">
                    {judgeMode === 'host' ? 'Host is deciding...' : 'Vote for your favorite'}
                  </p>
                  <p className="text-white/20 text-xs uppercase tracking-widest">
                    {judgeMode === 'host' ? 'Host judge' : 'Audience judge'}
                  </p>
                </div>

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

                {canVote && myVote && (
                  <div className="flex flex-col gap-3">
                    <p className="text-white/40 text-xs uppercase tracking-widest">Voted ✓</p>
                    <div className="flex gap-3">
                      <div className={`flex-1 text-center py-3 rounded-xl border transition-colors ${myVote === currentMatch.player1_id ? 'border-white/50 bg-white/10' : 'border-white/10'}`}>
                        <p className="text-white font-bold text-2xl">{p1Votes}</p>
                        <p className="text-white/40 text-xs mt-1">{pName(players, currentMatch.player1_id)}</p>
                      </div>
                      <div className={`flex-1 text-center py-3 rounded-xl border transition-colors ${myVote === currentMatch.player2_id ? 'border-white/50 bg-white/10' : 'border-white/10'}`}>
                        <p className="text-white font-bold text-2xl">{p2Votes}</p>
                        <p className="text-white/40 text-xs mt-1">{pName(players, currentMatch.player2_id)}</p>
                      </div>
                    </div>
                  </div>
                )}

                {!canVote && (
                  <p className="text-white/30 text-xs uppercase tracking-widest">
                    {isInMatch ? 'You\'re competing — sit tight' : 'Waiting for votes...'}
                  </p>
                )}

                {isHost && <button onClick={finishMatch} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg">Decide Winner →</button>}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col gap-5">
          {Array.from({ length: maxRound }, (_, i) => i + 1).map(round => (
            <div key={round}>
              <p className="text-xs tracking-[0.3em] text-white/30 uppercase mb-2">Round {round}</p>
              <div className="flex flex-col gap-2">
                {matches.filter(m => m.round === round).map(match => (
                  <div key={match.id} className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-colors ${match.id === currentMatch?.id ? 'border-white/40 bg-white/10' : 'border-white/10 bg-white/5'}`}>
                    <span className={`text-sm ${match.status === 'complete' && match.winner_id === match.player1_id ? 'text-white font-semibold' : 'text-white/50'}`}>{pName(players, match.player1_id)}</span>
                    <span className="text-white/20 text-xs">vs</span>
                    <span className={`text-sm ${match.status === 'complete' && match.winner_id === match.player2_id ? 'text-white font-semibold' : 'text-white/50'}`}>{pName(players, match.player2_id)}</span>
                    {match.status === 'complete' && <span className="text-white/30 text-xs ml-2">✓</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
