// Durable poll ordering is separate from the displayed overlay's lifetime.
// The worker supplies an exact authenticated binding and current classroom.
(function (root) {
  function apply(state, { contextKey, transientOrder, pollId, action, poll, now }) {
    if (!contextKey || !pollId || !Number.isSafeInteger(transientOrder) || transientOrder <= 0
      || !['start', 'close'].includes(action)) throw new Error('Poll ordering metadata is required');
    const previous = state.pollCursors?.[contextKey];
    if (previous && transientOrder <= previous.transientOrder) {
      return { state, newStart: false };
    }
    // The same poll cannot erase its answer or extend its original deadline.
    const samePoll = state.poll?.pollId === pollId && state.poll?.contextKey === contextKey;
    const olderPoll = state.poll?.contextKey === contextKey
      && (!Number.isSafeInteger(state.poll.transientOrder) || state.poll.transientOrder < transientOrder);
    const nextPoll = action === 'start'
      ? samePoll ? { ...state.poll, transientOrder,
        response: state.poll.response && !state.poll.response.status
          ? { ...state.poll.response, status: 'completed' } : state.poll.response } : { ...poll, contextKey, transientOrder }
      : samePoll || olderPoll ? null : state.poll;
    return { state: { ...state, poll: nextPoll, updatedAt: now,
      pollCursors: { ...state.pollCursors, [contextKey]: { transientOrder, pollId,
        ...(poll?.supervisionContextId ? { contextAuthorityRevision: poll.contextAuthorityRevision } : {}),
        status: action === 'close' ? 'closed' : 'active' } } },
    newStart: action === 'start' && !samePoll };
  }
  function reserveAnswer(state, pollId, contextKey, answer, now) {
    if (state.poll?.pollId !== pollId || state.poll?.contextKey !== contextKey
      || state.poll.expiresAt <= now) throw new Error('This poll is no longer active');
    if (state.poll.response) return state;
    return { ...state, poll: { ...state.poll, response: { ...answer, status: 'pending', chosenAt: now } }, updatedAt: now };
  }
  root.ClassPilotPollReplayCore = Object.freeze({ apply, reserveAnswer });
})(globalThis);
