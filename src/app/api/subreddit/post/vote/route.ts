import { getAuthSession } from '@/lib/auth';
import { db } from '@/lib/db';
import { redis } from '@/lib/redis';
import { PostVoteValidator } from '@/lib/validators/vote';
import { CachedPost } from '@/types/redis';
import { z } from 'zod';

const CACHE_AFTER_UPVOTES = 1;

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { postId, voteType } = PostVoteValidator.parse(body);

    const session = await getAuthSession();
    if (!session?.user) {
      return new Response('Unauthorized', { status: 401 });
    }

    // check if user has already voted on this post
    const existingVote = await db.vote.findFirst({
      where: { userId: session.user.id, postId },
    });

    const post = await db.post.findUnique({
      where: { id: postId },
      include: { author: true, votes: true },
    });

    if (!post) {
      return new Response('Post not found', { status: 404 });
    }

    // case 1: same vote → remove it
    if (existingVote && existingVote.type === voteType) {
      await db.vote.delete({
        where: { userId_postId: { postId, userId: session.user.id } },
      });

      const votesAmt = post.votes.reduce((acc, vote) => {
        if (vote.type === 'UP') return acc + 1;
        if (vote.type === 'DOWN') return acc - 1;
        return acc;
      }, 0);

      if (votesAmt >= CACHE_AFTER_UPVOTES) {
        const cachePayload: CachedPost = {
          authorUsername: post.author.username ?? '',
          content:
            typeof post.content === 'string'
              ? post.content
              : JSON.stringify(post.content),
          id: post.id,
          title: post.title,
          currentVote: null,
          createdAt: post.createdAt,
        };

        await redis.set(`post:${postId}`, JSON.stringify(cachePayload));
      }

      return new Response('OK');
    }

    // case 2: different vote → update it
    if (existingVote && existingVote.type !== voteType) {
      await db.vote.update({
        where: { userId_postId: { postId, userId: session.user.id } },
        data: { type: voteType },
      });

      const votesAmt = post.votes.reduce((acc, vote) => {
        if (vote.type === 'UP') return acc + 1;
        if (vote.type === 'DOWN') return acc - 1;
        return acc;
      }, 0);

      if (votesAmt >= CACHE_AFTER_UPVOTES) {
        const cachePayload: CachedPost = {
          authorUsername: post.author.username ?? '',
          content:
            typeof post.content === 'string'
              ? post.content
              : JSON.stringify(post.content),
          id: post.id,
          title: post.title,
          currentVote: voteType,
          createdAt: post.createdAt,
        };

        await redis.set(`post:${postId}`, JSON.stringify(cachePayload));
      }

      return new Response('OK');
    }

    // case 3: no existing vote → create
    await db.vote.upsert({
      where: { userId_postId: { userId: session.user.id, postId } },
      update: { type: voteType },
      create: { type: voteType, userId: session.user.id, postId },
    });

    const votesAmt = post.votes.reduce((acc, vote) => {
      if (vote.type === 'UP') return acc + 1;
      if (vote.type === 'DOWN') return acc - 1;
      return acc;
    }, 0);

    if (votesAmt >= CACHE_AFTER_UPVOTES) {
      const cachePayload: CachedPost = {
        authorUsername: post.author.username ?? '',
        content:
          typeof post.content === 'string'
            ? post.content
            : JSON.stringify(post.content),
        id: post.id,
        title: post.title,
        currentVote: voteType,
        createdAt: post.createdAt,
      };

      await redis.set(`post:${postId}`, JSON.stringify(cachePayload));
    }

    return new Response('OK');
  } catch (error) {
    console.error('[PATCH /vote] ERROR:', error);

    if (error instanceof z.ZodError) {
      return new Response(error.message, { status: 400 });
    }

    return new Response(
      'Could not post to subreddit at this time. Please try later',
      { status: 500 }
    );
  }
}
