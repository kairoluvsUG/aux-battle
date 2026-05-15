'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

type Player = { id: string; name: string; room_id: string }
type Room = { id: string; host_name: string; status: string }

export default function RoomPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [room, setRoom] = useState<Room | null>(null)
  const [players, setPlayers] = useState<Player[]>([])
  const [isHost, setIsHost] = useState(false)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    const host = localStorage.getItem('isHost') === 'true'
    setIsHost(host)

    async function load() {
      const { data: roomData } = await supabase.from('rooms').select().eq('id', id).single()
      if (!roomData) { router.push('/'); return }
      setRoom(roomData)
      if (roomData.status === 'playing') { router.push(`/room/${id}/bracket`); return }
      const { data: playersData } = await supabase.from('players').select().eq('room_id', id)
      setPlayers(playersData || [])
    }

    load()

    const sub = supabase
      .channel(`room-${id}-lobby`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'players', filter: `room_id=eq.${id}` }, (payload) => {
        setPlayers(prev => [...prev, payload.new as Player])
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'players', filter: `room_id=eq.${id}` }, (payload) => {
        setPlayers(prev => prev.filter(p => p.id !== payload.old.id))
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${id}` }, (payload) => {
        if (payload.new.status === 'playing') router.push(`/room/${id}/bracket`)
      })
      .subscribe()

    return () => { supabase.removeChannel(sub) }
  }, [id, router])

  async function startGame() {
    if (players.length < 2) return
    setStarting(true)
    const shuffled = [...players].sort(() => Math.random() - 0.5)
    const matches = []
    for (let i = 0; i < shuffled.length; i += 2) {
      matches.push({
        room_id: id,
        round: 1,
        position: Math.floor(i / 2),
        player1_id: shuffled[i].id,
        player2_id: shuffled[i + 1]?.id || null,
        status: i === 0 ? 'submitting' : 'pending',
      })
    }
    await supabase.from('matches').insert(matches)
    await supabase.from('rooms').update({ status: 'playing' }).eq('id', id)
  }

  async function leaveRoom() {
    const playerId = localStorage.getItem('playerId')
    if (playerId && !isHost) {
      await supabase.from('players').delete().eq('id', playerId)
    }
    localStorage.removeItem('playerName')
    localStorage.removeItem('roomId')
    localStorage.removeItem('isHost')
    localStorage.removeItem('playerId')
    router.push('/')
  }

  if (!room) return (
    <div className="min-h-screen bg-black flex items-center justify-center">
      <p className="text-white/40 text-sm tracking-widest uppercase">Loading...</p>
    </div>
  )

  return (
    <div className="min-h-screen relative flex flex-col items-center justify-center p-6 overflow-hidden">

      {/* Babyfxce E background */}
      <div className="absolute inset-0 z-0" style={{ backgroundImage: 'url(/babyfxce.jpg)', backgroundSize: 'cover', backgroundPosition: 'center 20%', backgroundRepeat: 'no-repeat', filter: 'grayscale(60%) brightness(0.85) contrast(1.1)' }} />
      <div className="absolute inset-0 z-10" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.75) 100%)' }} />

      {/* UI */}
      <div className="relative z-20 w-full max-w-sm flex flex-col gap-8">

        {/* Room code */}
        <div>
          <p className="text-xs tracking-[0.3em] text-white/50 uppercase mb-1">Room Code</p>
          <h1 className="text-6xl font-bold text-white leading-none tracking-tight">{id}</h1>
          <p className="text-white/40 text-xs tracking-widest uppercase mt-2">Share with friends</p>
        </div>

        {/* Players */}
        <div>
          <p className="text-xs tracking-[0.3em] text-white/50 uppercase mb-3">Players ({players.length})</p>
          <div className="flex flex-col gap-2">
            {players.map((p, i) => (
              <div key={p.id} className="flex items-center gap-3 py-2 border-b border-white/10">
                <span className="text-white/30 text-xs w-4">{i + 1}</span>
                <span className="text-white font-medium text-sm">{p.name}</span>
                {p.name === room.host_name && (
                  <span className="ml-auto text-xs text-white/30 uppercase tracking-widest">host</span>
                )}
              </div>
            ))}
            {players.length === 0 && (
              <p className="text-white/30 text-xs tracking-widest uppercase">Waiting for players...</p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3">
          {isHost ? (
            <>
              {players.length < 2 && (
                <p className="text-white/30 text-xs tracking-widest uppercase">Need at least 2 players</p>
              )}
              <button
                onClick={startGame}
                disabled={players.length < 2 || starting}
                className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 disabled:opacity-30 transition-colors"
              >
                {starting ? 'Building Bracket...' : 'Start Game'}
              </button>
            </>
          ) : (
            <p className="text-white/30 text-xs tracking-widest uppercase">Waiting for host to start...</p>
          )}

          <button
            onClick={leaveRoom}
            className="w-full py-3 bg-transparent border border-white/20 text-white/50 font-semibold text-sm tracking-widest uppercase rounded-lg hover:border-white/50 hover:text-white/80 transition-colors"
          >
            Leave Room
          </button>
        </div>
      </div>
    </div>
  )
}
