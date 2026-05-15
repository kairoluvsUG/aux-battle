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
    if (!name.trim()) return setError('Enter your name')
    setLoading(true)
    setError('')
    const id = generateRoomCode()
    const { error: err } = await supabase.from('rooms').insert({ id, host_name: name.trim() })
    if (err) { setError('Failed to create room'); setLoading(false); return }
    const { error: playerErr } = await supabase.from('players').insert({ room_id: id, name: name.trim() })
    if (playerErr) { setError('Failed to join room'); setLoading(false); return }
    localStorage.setItem('playerName', name.trim())
    localStorage.setItem('roomId', id)
    localStorage.setItem('isHost', 'true')
    router.push(`/room/${id}`)
  }

  async function joinRoom() {
    if (!name.trim()) return setError('Enter your name')
    if (!roomCode.trim()) return setError('Enter a room code')
    setLoading(true)
    setError('')
    const code = roomCode.trim().toUpperCase()
    const { data: room, error: roomErr } = await supabase.from('rooms').select().eq('id', code).single()
    if (roomErr || !room) { setError('Room not found'); setLoading(false); return }
    if (room.status !== 'lobby') { setError('Game already started'); setLoading(false); return }
    const { error: playerErr } = await supabase.from('players').insert({ room_id: code, name: name.trim() })
    if (playerErr) { setError('Failed to join room'); setLoading(false); return }
    localStorage.setItem('playerName', name.trim())
    localStorage.setItem('roomId', code)
    localStorage.setItem('isHost', 'false')
    router.push(`/room/${code}`)
  }

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <h1 className="text-5xl font-black text-white mb-2">🎵 AUX BATTLE</h1>
          <p className="text-zinc-400 text-lg">The ultimate music bracket showdown</p>
        </div>

        {mode === 'home' && (
          <div className="flex flex-col gap-4">
            <button
              onClick={() => setMode('create')}
              className="w-full py-4 bg-purple-600 hover:bg-purple-500 text-white font-bold text-lg rounded-2xl transition-colors"
            >
              Create Room
            </button>
            <button
              onClick={() => setMode('join')}
              className="w-full py-4 bg-zinc-800 hover:bg-zinc-700 text-white font-bold text-lg rounded-2xl transition-colors"
            >
              Join Room
            </button>
          </div>
        )}

        {mode === 'create' && (
          <div className="flex flex-col gap-4">
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full py-4 px-5 bg-zinc-800 text-white rounded-2xl text-lg outline-none focus:ring-2 focus:ring-purple-500 placeholder:text-zinc-500"
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button
              onClick={createRoom}
              disabled={loading}
              className="w-full py-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-bold text-lg rounded-2xl transition-colors"
            >
              {loading ? 'Creating...' : 'Create Room'}
            </button>
            <button onClick={() => { setMode('home'); setError('') }} className="text-zinc-500 hover:text-white transition-colors text-sm">
              ← Back
            </button>
          </div>
        )}

        {mode === 'join' && (
          <div className="flex flex-col gap-4">
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full py-4 px-5 bg-zinc-800 text-white rounded-2xl text-lg outline-none focus:ring-2 focus:ring-purple-500 placeholder:text-zinc-500"
            />
            <input
              type="text"
              placeholder="Room code"
              value={roomCode}
              onChange={e => setRoomCode(e.target.value.toUpperCase())}
              className="w-full py-4 px-5 bg-zinc-800 text-white rounded-2xl text-lg outline-none focus:ring-2 focus:ring-purple-500 placeholder:text-zinc-500 tracking-widest"
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button
              onClick={joinRoom}
              disabled={loading}
              className="w-full py-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-bold text-lg rounded-2xl transition-colors"
            >
              {loading ? 'Joining...' : 'Join Room'}
            </button>
            <button onClick={() => { setMode('home'); setError('') }} className="text-zinc-500 hover:text-white transition-colors text-sm">
              ← Back
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
