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
  const [playerName, setPlayerName] = useState('')
  const [isHost, setIsHost] = useState(false)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    const name = localStorage.getItem('playerName') || ''
    const host = localStorage.getItem('isHost') === 'true'
    setPlayerName(name)
    setIsHost(host)

    async function load() {
      const { data: roomData } = await supabase.from('rooms').select().eq('id', id).single()
      if (!roomData) { router.push('/'); return }
      setRoom(roomData)
      if (roomData.status === 'playing') {
        router.push(`/room/${id}/bracket`)
        return
      }
      const { data: playersData } = await supabase.from('players').select().eq('room_id', id)
      setPlayers(playersData || [])
    }

    load()

    const playersSub = supabase
      .channel(`room-${id}-players`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${id}` }, () => {
        supabase.from('players').select().eq('room_id', id).then(({ data }) => setPlayers(data || []))
      })
      .subscribe()

    const roomSub = supabase
      .channel(`room-${id}-status`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${id}` }, (payload) => {
        if (payload.new.status === 'playing') {
          router.push(`/room/${id}/bracket`)
        }
      })
      .subscribe()

    return () => {
      supabase.removeChannel(playersSub)
      supabase.removeChannel(roomSub)
    }
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
      })
    }

    await supabase.from('matches').insert(matches)
    await supabase.from('rooms').update({ status: 'playing' }).eq('id', id)
  }

  if (!room) return (
    <div className="min-h-screen bg-black flex items-center justify-center">
      <p className="text-zinc-400 text-lg">Loading...</p>
    </div>
  )

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <p className="text-zinc-500 text-sm uppercase tracking-widest mb-1">Room Code</p>
          <h1 className="text-6xl font-black text-white tracking-widest">{id}</h1>
          <p className="text-zinc-400 mt-2">Share this code with your friends</p>
        </div>

        <div className="bg-zinc-900 rounded-2xl p-6 mb-6">
          <h2 className="text-zinc-400 text-sm uppercase tracking-widest mb-4">
            Players ({players.length})
          </h2>
          <div className="flex flex-col gap-3">
            {players.map((p, i) => (
              <div key={p.id} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold">
                  {i + 1}
                </div>
                <span className="text-white font-medium">{p.name}</span>
                {p.name === room.host_name && (
                  <span className="text-xs text-purple-400 ml-auto">host</span>
                )}
              </div>
            ))}
            {players.length === 0 && (
              <p className="text-zinc-600 text-sm">Waiting for players...</p>
            )}
          </div>
        </div>

        {isHost ? (
          <div>
            {players.length < 2 && (
              <p className="text-zinc-500 text-sm text-center mb-3">Need at least 2 players to start</p>
            )}
            <button
              onClick={startGame}
              disabled={players.length < 2 || starting}
              className="w-full py-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-bold text-lg rounded-2xl transition-colors"
            >
              {starting ? 'Building bracket...' : 'Start Game'}
            </button>
          </div>
        ) : (
          <p className="text-center text-zinc-500">Waiting for the host to start the game...</p>
        )}
      </div>
    </div>
  )
}
