'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

const VIDEOS = [
  { id: 'xpVfcZ0ZcFM', start: 30 },  // Drake - God's Plan
  { id: 'tvTRZJ-4EyI', start: 10 },  // Kendrick - HUMBLE.
  { id: '6ONRf7h3Mdk', start: 25 },  // Travis Scott - SICKO MODE
  { id: 'PEGccV-NOm8', start: 15 },  // Cardi B - Bodak Yellow
  { id: 'UceaB4D0jpo', start: 20 },  // Post Malone - Rockstar
  { id: 'LITFMyRkMi0', start: 40 },  // Migos - Bad and Boujee
  { id: 'RKnAIQ4Ksr4', start: 18 },  // Lil Uzi - XO TOUR
  { id: 'xvZqHgFz51I', start: 22 },  // Future - Mask Off
  { id: 'mzB1VGEGcSU', start: 35 },  // Juice WRLD - Lucid Dreams
  { id: 'wE7RLqCeLDg', start: 12 },  // 21 Savage - Bank Account
]

declare global {
  interface Window {
    YT: any
    onYouTubeIframeAPIReady: () => void
  }
}

export default function Home() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [roomCode, setRoomCode] = useState('')
  const [mode, setMode] = useState<'home' | 'create' | 'join'>('home')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fade, setFade] = useState(true)
  const playerRef = useRef<any>(null)
  const videoIndexRef = useRef(0)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)

    window.onYouTubeIframeAPIReady = () => {
      playerRef.current = new window.YT.Player('yt-bg', {
        videoId: VIDEOS[0].id,
        playerVars: {
          autoplay: 1,
          mute: 1,
          controls: 0,
          showinfo: 0,
          rel: 0,
          loop: 0,
          start: VIDEOS[0].start,
          playsinline: 1,
          modestbranding: 1,
        },
        events: {
          onReady: (e: any) => {
            e.target.playVideo()
            startCycling()
          },
        },
      })
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  function startCycling() {
    const duration = Math.floor(Math.random() * 3000) + 2000
    intervalRef.current = setTimeout(function cycle() {
      setFade(false)
      setTimeout(() => {
        videoIndexRef.current = (videoIndexRef.current + 1) % VIDEOS.length
        const next = VIDEOS[videoIndexRef.current]
        if (playerRef.current) {
          playerRef.current.loadVideoById({ videoId: next.id, startSeconds: next.start })
          playerRef.current.mute()
        }
        setFade(true)
        const nextDuration = Math.floor(Math.random() * 3000) + 2000
        intervalRef.current = setTimeout(cycle, nextDuration)
      }, 500)
    }, duration)
  }

  async function createRoom() {
    if (!name.trim()) return setError('Enter your name')
    setLoading(true)
    setError('')
    const id = generateRoomCode()
    const { error: err } = await supabase.from('rooms').insert({ id, host_name: name.trim() })
    if (err) { setError('Failed to create room'); setLoading(false); return }
    await supabase.from('players').insert({ room_id: id, name: name.trim() })
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
    await supabase.from('players').insert({ room_id: code, name: name.trim() })
    localStorage.setItem('playerName', name.trim())
    localStorage.setItem('roomId', code)
    localStorage.setItem('isHost', 'false')
    router.push(`/room/${code}`)
  }

  return (
    <div className="min-h-screen relative flex flex-col items-center justify-center p-6 overflow-hidden">

      {/* YouTube background */}
      <div
        className="absolute inset-0 z-0 transition-opacity duration-500"
        style={{ opacity: fade ? 1 : 0 }}
      >
        <div id="yt-bg" className="absolute inset-0 w-full h-full pointer-events-none" style={{ transform: 'scale(1.5)' }} />
      </div>

      {/* Dark overlay */}
      <div className="absolute inset-0 z-10 bg-black/70" />

      {/* UI */}
      <div className="relative z-20 w-full max-w-md">
        <div className="text-center mb-10">
          <h1 className="text-5xl font-black text-white mb-2">🎵 AUX BATTLE</h1>
          <p className="text-zinc-400 text-lg">The ultimate music bracket showdown</p>
        </div>

        {mode === 'home' && (
          <div className="flex flex-col gap-4">
            <button onClick={() => setMode('create')} className="w-full py-4 bg-purple-600 hover:bg-purple-500 text-white font-bold text-lg rounded-2xl transition-colors">
              Create Room
            </button>
            <button onClick={() => setMode('join')} className="w-full py-4 bg-zinc-800 hover:bg-zinc-700 text-white font-bold text-lg rounded-2xl transition-colors">
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
              className="w-full py-4 px-5 bg-zinc-800/80 text-white rounded-2xl text-lg outline-none focus:ring-2 focus:ring-purple-500 placeholder:text-zinc-500"
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button onClick={createRoom} disabled={loading} className="w-full py-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-bold text-lg rounded-2xl transition-colors">
              {loading ? 'Creating...' : 'Create Room'}
            </button>
            <button onClick={() => { setMode('home'); setError('') }} className="text-zinc-400 hover:text-white transition-colors text-sm">← Back</button>
          </div>
        )}

        {mode === 'join' && (
          <div className="flex flex-col gap-4">
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full py-4 px-5 bg-zinc-800/80 text-white rounded-2xl text-lg outline-none focus:ring-2 focus:ring-purple-500 placeholder:text-zinc-500"
            />
            <input
              type="text"
              placeholder="Room code"
              value={roomCode}
              onChange={e => setRoomCode(e.target.value.toUpperCase())}
              className="w-full py-4 px-5 bg-zinc-800/80 text-white rounded-2xl text-lg outline-none focus:ring-2 focus:ring-purple-500 placeholder:text-zinc-500 tracking-widest"
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button onClick={joinRoom} disabled={loading} className="w-full py-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-bold text-lg rounded-2xl transition-colors">
              {loading ? 'Joining...' : 'Join Room'}
            </button>
            <button onClick={() => { setMode('home'); setError('') }} className="text-zinc-400 hover:text-white transition-colors text-sm">← Back</button>
          </div>
        )}
      </div>
    </div>
  )
}
