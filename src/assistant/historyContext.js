const MAX_HISTORY_TURNS = 4;
const MAX_HISTORY_CHARACTERS = 6000;
function validateHistory(value) {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_TURNS)
    throw new Error('Choose a bounded conversation history.');
  let size = 0;
  const history = value.map((turn) => {
    if (
      !turn ||
      typeof turn !== 'object' ||
      Array.isArray(turn) ||
      Object.keys(turn).sort().join(',') !== 'answer,question' ||
      typeof turn.question !== 'string' ||
      !turn.question.trim() ||
      turn.question.length > 500 ||
      typeof turn.answer !== 'string' ||
      !turn.answer.trim() ||
      turn.answer.length > 1200
    )
      throw new Error('The conversation history is invalid.');
    size += turn.question.length + turn.answer.length;
    return Object.freeze({ question: turn.question.trim(), answer: turn.answer.trim() });
  });
  if (size > MAX_HISTORY_CHARACTERS) throw new Error('The conversation history is too long.');
  return Object.freeze(history);
}
module.exports = { MAX_HISTORY_TURNS, MAX_HISTORY_CHARACTERS, validateHistory };
