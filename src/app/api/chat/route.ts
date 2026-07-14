import { handleChatStream } from '@mastra/ai-sdk'
import { toAISdkV5Messages } from '@mastra/ai-sdk/ui'
import { createUIMessageStreamResponse } from 'ai'
import { auth } from '@clerk/nextjs/server'
import { mastra } from '@/mastra'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const THREAD_ID = userId
  const RESOURCE_ID = `chat-${userId}`

  const params = await req.json()
  const stream = await handleChatStream({
    mastra,
    agentId: 'market-chat-agent',
    // Cache the system prompt at the provider level (Anthropic ephemeral cache).
    // This is a no-op for Groq/OpenAI/Cerebras — safe to leave on regardless of AI_PROVIDER.
    defaultOptions: {
      providerOptions: {
        anthropic: {
          cacheControl: { type: 'ephemeral' },
        },
      },
    },
    params: {
      ...params,
      context: [
        {
          role: 'system',
          content: `userId:${userId}`,
        },
      ],
      memory: {
        ...params.memory,
        thread: THREAD_ID,
        resource: RESOURCE_ID,
      },
    },
  })
  return createUIMessageStreamResponse({ stream })
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const THREAD_ID = userId
  const RESOURCE_ID = `chat-${userId}`

  const memory = await mastra.getAgentById('market-chat-agent').getMemory()
  let response = null

  try {
    response = await memory?.recall({
      threadId: THREAD_ID,
      resourceId: RESOURCE_ID,
    })
  } catch {
    console.log('No previous messages found.')
  }

  const uiMessages = toAISdkV5Messages(response?.messages || [])

  return NextResponse.json(uiMessages)
}
