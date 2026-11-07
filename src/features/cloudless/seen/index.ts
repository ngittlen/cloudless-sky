/*
 * Entry point for the seen-posts feature. Upstream files import from here.
 * Importing it connects the recorder to the saved seen lists, so every post
 * the recorder notices is remembered.
 */
import {connectRecorderToSeenLists} from './seenList'

export {recordSeenFeedRow} from './recorder'

connectRecorderToSeenLists()
