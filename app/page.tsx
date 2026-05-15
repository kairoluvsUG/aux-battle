'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

export default function Home() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [roomCode, setRoomCode] = useState('')
  const [mode, setMode] = useState<'home' | 'create' | 'join'>('home')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function createRoom() {
    if (name.trim().length < 3) return setError('Name must be at least 3 characters')
    setLoading(true)
    setError('')
    const id = generateRoomCode()
    const { error: err } = await supabase.from('rooms').insert({ id, host_name: name.trim() })
    if (err) { setError('Failed to create room'); setLoading(false); return }
    const { data: playerData } = await supabase.from('players').insert({ room_id: id, name: name.trim() }).select().single()
    localStorage.setItem('playerName', name.trim())
    localStorage.setItem('roomId', id)
    localStorage.setItem('isHost', 'true')
    localStorage.setItem('playerId', playerData?.id || '')
    router.push(`/room/${id}`)
  }

  async function joinRoom() {
    if (name.trim().length < 3) return setError('Name must be at least 3 characters')
    if (!roomCode.trim()) return setError('Enter a room code')
    setLoading(true)
    setError('')
    const code = roomCode.trim().toUpperCase()
    const { data: room, error: roomErr } = await supabase.from('rooms').select().eq('id', code).single()
    if (roomErr || !room) { setError('Room not found'); setLoading(false); return }
    if (room.status !== 'lobby') { setError('Game already started'); setLoading(false); return }
    // Check if player already exists (rejoining)
    const { data: existing } = await supabase.from('players').select().eq('room_id', code).eq('name', name.trim()).single()
    let playerId = existing?.id
    if (!playerId) {
      // Check for duplicate name
      const { data: taken } = await supabase.from('players').select('id').eq('room_id', code).ilike('name', name.trim())
      if (taken && taken.length > 0) { setError('That name is already taken in this room'); setLoading(false); return }
      const { data: newPlayer } = await supabase.from('players').insert({ room_id: code, name: name.trim() }).select().single()
      playerId = newPlayer?.id
    }
    localStorage.setItem('playerName', name.trim())
    localStorage.setItem('roomId', code)
    localStorage.setItem('isHost', 'false')
    localStorage.setItem('playerId', playerId || '')
    router.push(`/room/${code}`)
  }

  return (
    <div className="min-h-screen relative flex flex-col items-center justify-center p-6 overflow-hidden">

      {/* Carti background */}
      <div
        className="absolute inset-0 z-0"
        style={{
          backgroundImage: 'url(/carti.jpg)',
          backgroundSize: 'cover',
          backgroundPosition: 'center top',
          backgroundRepeat: 'no-repeat',
          filter: 'grayscale(20%) brightness(0.75)',
        }}
      />

      {/* Subtle gradient overlay — darkens bottom for readability */}
      <div className="absolute inset-0 z-10" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.5) 100%)' }} />

      {/* UI */}
      <div className="relative z-20 w-full max-w-sm flex flex-col gap-8">

        {/* Title */}
        <div>
          <p className="text-xs tracking-[0.3em] text-white/50 uppercase mb-1">Music Battle</p>
          <h1 className="text-6xl font-bold text-white leading-none tracking-tight">AUX<br />BATTLE</h1>
        </div>

        {mode === 'home' && (
          <div className="flex flex-col gap-3">
            <button
              onClick={() => setMode('create')}
              className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 transition-colors"
            >
              Create Room
            </button>
            <button
              onClick={() => setMode('join')}
              className="w-full py-3 bg-transparent border border-white/40 text-white font-semibold text-sm tracking-widest uppercase rounded-lg hover:border-white/80 transition-colors"
            >
              Join Room
            </button>
          </div>
        )}

        {mode === 'create' && (
          <div className="flex flex-col gap-3">
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full py-3 px-4 bg-white/10 border border-white/20 text-white rounded-lg text-sm outline-none focus:border-white/60 placeholder:text-white/30 transition-colors"
            />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button
              onClick={createRoom}
              disabled={loading}
              className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 disabled:opacity-40 transition-colors"
            >
              {loading ? 'Creating...' : 'Create Room'}
            </button>
            <button onClick={() => { setMode('home'); setError('') }} className="text-white/40 hover:text-white/70 text-xs tracking-widest uppercase transition-colors">
              ← Back
            </button>
          </div>
        )}

        {mode === 'join' && (
          <div className="flex flex-col gap-3">
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full py-3 px-4 bg-white/10 border border-white/20 text-white rounded-lg text-sm outline-none focus:border-white/60 placeholder:text-white/30 transition-colors"
            />
            <input
              type="text"
              placeholder="Room code"
              value={roomCode}
              onChange={e => setRoomCode(e.target.value.toUpperCase())}
              className="w-full py-3 px-4 bg-white/10 border border-white/20 text-white rounded-lg text-sm outline-none focus:border-white/60 placeholder:text-white/30 tracking-widest transition-colors"
            />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button
              onClick={joinRoom}
              disabled={loading}
              className="w-full py-3 bg-white text-black font-semibold text-sm tracking-widest uppercase rounded-lg hover:bg-white/90 disabled:opacity-40 transition-colors"
            >
              {loading ? 'Joining...' : 'Join Room'}
            </button>
            <button onClick={() => { setMode('home'); setError('') }} className="text-white/40 hover:text-white/70 text-xs tracking-widest uppercase transition-colors">
              ← Back
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
