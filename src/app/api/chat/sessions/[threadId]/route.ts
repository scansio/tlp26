import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { mastraStorage } from '@/mastra/storage'

async function verifyOwnership(threadId: string, userId: string) {
  const memory = await mastraStorage.getStore('memory')
  if (!memory) return null
  const thread = await memory.getThreadById({ threadId })
  if (!thread || thread.resourceId !== `chat-${userId}`) return null
  return { memory, thread }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const { userId } = await auth()
  if (!userId) return new NextResponse('Unauthorized', { status: 401 })

  const { threadId } = await params
  const owned = await verifyOwnership(threadId, userId)
  if (!owned) return new NextResponse('Not found', { status: 404 })

  await owned.memory.deleteThread({ threadId })
  return new NextResponse(null, { status: 204 })
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const { userId } = await auth()
  if (!userId) return new NextResponse('Unauthorized', { status: 401 })

  const { threadId } = await params
  const { title } = await req.json()

  const owned = await verifyOwnership(threadId, userId)
  if (!owned) return new NextResponse('Not found', { status: 404 })

  const updated = await owned.memory.updateThread({ id: threadId, title, metadata: owned.thread.metadata as Record<string, unknown> })
  return NextResponse.json(updated)
}
