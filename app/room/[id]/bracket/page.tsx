'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

type Player = { id: string; name: string }
type Match = {
  id: string
  room_id: string
  round: number
  position: number
  player1_id: string | null
  player2_id: string | null
  player1_song: string | null
  player2_song: string | null
  winner_id: string | null
  status: string
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
  const [mySong, setMySong] = useState('')
  const [myVote, setMyVote] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const currentMatch = matches.find(m => m.status !== 'complete' && m.status !== 'pending')
  const maxRound = matches.length > 0 ? Math.max(...matches.map(m => m.round)) : 1

  const loadAll = useCallback(async () => {
    const [mRes, pRes, vRes] = await Promise.all([
      supabase.from('matches').select().eq('room_id', id).order('round').order('position'),
      supabase.from('players').select().eq('room_id', id),
      supabase.from('votes').select(),
    ])
    if (mRes.data) setMatches(mRes.data)
    if (pRes.data) setPlayers(pRes.data)
    if (vRes.data) setVotes(vRes.data)
  }, [id])

  useEffect(() => {
    setIsHost(localStorage.getItem('isHost') === 'true')
    setMyPlayerId(localStorage.getItem('playerId') || '')
    loadAll()

    const sub = supabase
      .channel(`bracket-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `room_id=eq.${id}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'votes' }, loadAll)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${id}` }, (p) => {
        if (p.new.status === 'finished') loadAll()
      })
      .subscribe()

    return () => { supabase.removeChannel(sub) }
  }, [id, loadAll])

  // Reset my vote when match changes
  useEffect(() => { setMyVote(null) }, [currentMatch?.id])

  async function submitSong() {
    if (!mySong.trim() || !currentMatch) return
    setSubmitting(true)
    const isP1 = currentMatch.player1_id === myPlayerId
    await supabase.from('matches').update({ [isP1 ? 'player1_song' : 'player2_song']: mySong.trim() }).eq('id', currentMatch.id)
    setMySong('')
    setSubmitting(false)
  }

  async function hostSet(status: string) {
    if (!currentMatch) return
    await supabase.from('matches').update({ status }).eq('id', currentMatch.id)
  }

  async function castVote(votedFor: string) {
    if (!currentMatch || myVote) return
    const name = players.find(p => p.id === myPlayerId)?.name || 'Anon'
    await supabase.from('votes').insert({ match_id: currentMatch.id, voter_name: name, voted_for: votedFor })
    setMyVote(votedFor)
  }

  async function finishMatch() {
    if (!currentMatch) return
    const matchVotes = votes.filter(v => v.match_id === currentMatch.id)
    const p1v = matchVotes.filter(v => v.voted_for === currentMatch.player1_id).length
    const p2v = matchVotes.filter(v => v.voted_for === currentMatch.player2_id).length
    const winnerId = p1v >= p2v ? currentMatch.player1_id! : currentMatch.player2_id!

    await supabase.from('matches').update({ winner_id: winnerId, status: 'complete' }).eq('id', currentMatch.id)

    const roundMatches = matches.filter(m => m.round === currentMatch.round)
    const nextInRound = roundMatches.find(m => m.position === currentMatch.position + 1 && m.status === 'pending')

    if (nextInRound) {
      await supabase.from('matches').update({ status: 'submitting' }).eq('id', nextInRound.id)
    } else {
      // All matches in round done — gather winners and make next round
      const updatedRound = roundMatches.map(m => m.id === currentMatch.id ? { ...m, winner_id: winnerId } : m)
      const winners = updatedRound.map(m => m.winner_id).filter(Boolean) as string[]

      if (winners.length <= 1) {
        await supabase.from('rooms').update({ status: 'finished' }).eq('id', id)
      } else {
        const nextRound = currentMatch.round + 1
        const nextMatches = []
        for (let i = 0; i < winners.length; i += 2) {
          nextMatches.push({
            room_id: id,
            round: nextRound,
            position: Math.floor(i / 2),
            player1_id: winners[i],
            player2_id: winners[i + 1] || null,
            status: i === 0 ? 'submitting' : 'pending',
          })
        }
        await supabase.from('matches').insert(nextMatches)
      }
    }
  }

  const isFinished = matches.length > 0 && matches.every(m => m.status === 'complete') || matches.some(m => m.round === maxRound && m.status === 'complete')
  const finalWinner = isFinished ? players.find(p => p.id === matches.filter(m => m.status === 'complete').sort((a, b) => b.round - a.round)[0]?.winner_id) : null

  function renderEmbed(url: string | null, label: string) {
    if (!url) return null
    const embed = getEmbedUrl(url)
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs tracking-[0.3em] text-white/40 uppercase">{label}</p>
        {embed ? (
          <iframe src={embed} className="w-full rounded-xl" height={url.includes('spotify') ? 152 : 180} allow="autoplay; clipboard-write; encrypted-media; fullscreen" allowFullScreen />
        ) : (
          <a href={url} target="_blank" className="text-white/50 underline text-sm break-all">{url}</a>
        )}
      </div>
    )
  }

  // Winner screen
  if (finalWinner) {
    return (
      <div className="min-h-screen relative flex flex-col items-center justify-center p-6 overflow-hidden">
        <div className="absolute inset-0 z-0" style={{ backgroundImage: 'url(/carti.jpg)', backgroundSize: 'cover', backgroundPosition: 'center top', filter: 'grayscale(20%) brightness(0.75)' }} />
        <div className="absolute inset-0 z-10" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.6) 100%)' }} />
        <div className="relative z-20 text-center flex flex-col gap-6">
          <div>
            <p className="text-xs tracking-[0.3em] text-white/50 uppercase mb-2">AUX Battle Winner</p>
            <h1 className="text-7xl font-bold text-white leading-none">{finalWinner.name}</h1>
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

  return (
    <div className="min-h-screen relative flex flex-col p-4 pb-10 overflow-hidden">
      {/* Carti background */}
      <div className="absolute inset-0 z-0" style={{ backgroundImage: 'url(/carti.jpg)', backgroundSize: 'cover', backgroundPosition: 'center top', filter: 'grayscale(20%) brightness(0.75)' }} />
      <div className="absolute inset-0 z-10" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.65) 100%)' }} />

      <div className="relative z-20 w-full max-w-lg mx-auto flex flex-col gap-6 pt-6">

        {/* Header */}
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs tracking-[0.3em] text-white/40 uppercase mb-1">Round {currentMatch?.round ?? maxRound}</p>
            <h1 className="text-4xl font-bold text-white leading-none">AUX BATTLE</h1>
          </div>
          <button onClick={() => router.push('/')} className="text-white/30 text-xs tracking-widest uppercase hover:text-white/60 transition-colors">Leave</button>
        </div>

        {/* Current match card */}
        {currentMatch && (
          <div className="bg-black/40 backdrop-blur-sm rounded-2xl p-5 border border-white/10 flex flex-col gap-5">

            {/* Players */}
            <div className="flex items-center justify-between">
              <span className="text-white font-bold text-lg">{pName(players, currentMatch.player1_id)}</span>
              <span className="text-white/30 text-sm font-light">vs</span>
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
                      className="w-full py-3 px-4 bg-white/10 border border-white/20 text-white rounded-lg text-sm outline-none focus:border-white/50 placeholder:text-white/25 transition-colors"
                    />
                    <button onClick={submitSong} disabled={submitting || !mySong.trim()} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 disabled:opacity-40 transition-colors">
                      Submit Song
                    </button>
                  </>
                ) : isInMatch && myAlreadySubmitted ? (
                  <p className="text-white/40 text-xs uppercase tracking-widest">Song locked in — waiting for opponent...</p>
                ) : (
                  <p className="text-white/40 text-xs uppercase tracking-widest">
                    Waiting for {!currentMatch.player1_song ? pName(players, currentMatch.player1_id) : pName(players, currentMatch.player2_id)} to submit...
                  </p>
                )}
                {isHost && currentMatch.player1_song && currentMatch.player2_song && (
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
                  <button onClick={() => hostSet('playing_p2')} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg">
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
                  <button onClick={() => hostSet('voting')} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg">
                    Open Voting →
                  </button>
                )}
              </div>
            )}

            {/* VOTING */}
            {currentMatch.status === 'voting' && (
              <div className="flex flex-col gap-4">
                <p className="text-white/40 text-xs uppercase tracking-widest">Vote for your favorite</p>
                {!myVote ? (
                  <div className="flex gap-3">
                    <button onClick={() => castVote(currentMatch.player1_id!)} className="flex-1 py-4 bg-white/10 border border-white/20 text-white font-semibold text-sm rounded-xl hover:bg-white/20 transition-colors">
                      {pName(players, currentMatch.player1_id)}
                    </button>
                    <button onClick={() => castVote(currentMatch.player2_id!)} className="flex-1 py-4 bg-white/10 border border-white/20 text-white font-semibold text-sm rounded-xl hover:bg-white/20 transition-colors">
                      {pName(players, currentMatch.player2_id)}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <p className="text-white/40 text-xs uppercase tracking-widest">Voted — waiting for results</p>
                    <div className="flex gap-3">
                      <div className="flex-1 text-center">
                        <p className="text-white font-bold text-2xl">{p1Votes}</p>
                        <p className="text-white/40 text-xs">{pName(players, currentMatch.player1_id)}</p>
                      </div>
                      <div className="flex-1 text-center">
                        <p className="text-white font-bold text-2xl">{p2Votes}</p>
                        <p className="text-white/40 text-xs">{pName(players, currentMatch.player2_id)}</p>
                      </div>
                    </div>
                  </div>
                )}
                {isHost && (
                  <button onClick={finishMatch} className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg">
                    Decide Winner →
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Bracket */}
        <div className="flex flex-col gap-5">
          {Array.from({ length: maxRound }, (_, i) => i + 1).map(round => (
            <div key={round}>
              <p className="text-xs tracking-[0.3em] text-white/30 uppercase mb-2">Round {round}</p>
              <div className="flex flex-col gap-2">
                {matches.filter(m => m.round === round).map(match => (
                  <div key={match.id} className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-colors ${match.id === currentMatch?.id ? 'border-white/40 bg-white/10' : 'border-white/10 bg-white/5'}`}>
                    <span className={`text-sm ${match.status === 'complete' && match.winner_id === match.player1_id ? 'text-white font-semibold' : 'text-white/50'}`}>
                      {pName(players, match.player1_id)}
                    </span>
                    <span className="text-white/20 text-xs">vs</span>
                    <span className={`text-sm ${match.status === 'complete' && match.winner_id === match.player2_id ? 'text-white font-semibold' : 'text-white/50'}`}>
                      {pName(players, match.player2_id)}
                    </span>
                    {match.status === 'complete' && <span className="text-white/20 text-xs ml-2">✓</span>}
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
