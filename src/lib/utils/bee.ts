import { FeedIndex } from '@ethersphere/bee-js'
import { Options, readCommentsInRange } from '@solarpunkltd/comment-system'

import { EVENTS } from '../lib/constants'

import { EventEmitter } from './eventEmitter'
import { Logger } from './logger'

const logger = Logger.getInstance()

export async function fetchMessagesInRange(
  startIndex: bigint,
  endIndex: bigint,
  emitter: EventEmitter,
  commentOptions: Options,
): Promise<void> {
  logger.debug('Fetching previous messages from: ', startIndex.toString(), ' to: ', endIndex.toString())

  const comments = await readCommentsInRange(
    FeedIndex.fromBigInt(startIndex),
    FeedIndex.fromBigInt(endIndex),
    commentOptions,
  )

  if (!comments) {
    logger.warn('No comments found in the specified range from: ', startIndex.toString(), ' to: ', endIndex.toString())
    emitter.emit(EVENTS.LOADING_INIT, false)

    return
  }
  emitter.emit(EVENTS.LOADING_INIT, false)

  for (let ix = 0; ix < comments.length; ix++) {
    const comment = comments[ix]
    emitter.emit(EVENTS.MESSAGE_RECEIVED, comment)
  }
}
