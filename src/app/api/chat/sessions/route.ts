import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { mastraStorage } from '@/mastra/storage'

function resourceId(userId: string) {
  return `chat-${userId}`
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return new NextResponse('Unauthorized', { status: 401 })

  const memory = await mastraStorage.getStore('memory')
  if (!memory) return NextResponse.json([])

  const result = await memory.listThreads({
    filter: { resourceId: resourceId(userId) },
    orderBy: { field: 'updatedAt', direction: 'DESC' },
  })

  return NextResponse.json(result.threads)
}

export async function POST(req: Request) {
  const { userId } = await auth()
  if (!userId) return new NextResponse('Unauthorized', { status: 401 })

  const { title } = await req.json().catch(() => ({}))

  const memory = await mastraStorage.getStore('memory')
  if (!memory) return new NextResponse('Storage unavailable', { status: 503 })

  const id = `${userId}-${crypto.randomUUID()}`
  const now = new Date()

  await memory.saveThread({
    thread: {
      id,
      resourceId: resourceId(userId),
      title: title || 'New Chat',
      metadata: {},
      createdAt: now,
      updatedAt: now,
    },
  })

  return NextResponse.json({ id, title: title || 'New Chat', createdAt: now })
}
