import { handleChatStream } from '@mastra/ai-sdk';
import { toAISdkV5Messages } from '@mastra/ai-sdk/ui';
import { createUIMessageStreamResponse } from 'ai';
import { auth } from '@clerk/nextjs/server';
import { RequestContext } from '@mastra/core/request-context';
import { mastra } from '@/mastra';
import { NextResponse } from 'next/server';

const AGENT_ID = 'setup-agent';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const THREAD_ID = `setup-${userId}`;
  const RESOURCE_ID = `setup-${userId}`;

  // Build a RequestContext so tools can securely read the userId
  // without it being exposed in the tool input schema.
  const requestContext = new RequestContext<{ userId: string }>();
  requestContext.set('userId', userId);

  const params = await req.json();
  const stream = await handleChatStream({
    mastra,
    agentId: AGENT_ID,
    params: {
      ...params,
      requestContext,
      memory: {
        ...params.memory,
        thread: THREAD_ID,
        resource: RESOURCE_ID,
      },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createUIMessageStreamResponse({ stream: stream as any });
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const THREAD_ID = `setup-${userId}`;
  const RESOURCE_ID = `setup-${userId}`;

  const memory = await mastra.getAgentById(AGENT_ID).getMemory();
  let uiMessages: ReturnType<typeof toAISdkV5Messages> = [];

  try {
    const response = await memory?.recall({
      threadId: THREAD_ID,
      resourceId: RESOURCE_ID,
    });
    uiMessages = toAISdkV5Messages(response?.messages ?? []);
  } catch {
    // No previous messages — return empty array
  }

  return NextResponse.json(uiMessages);
}
