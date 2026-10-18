const ownerCodec = require('./ownerCodec');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const encodeDataFamily = ownerCodec.encodeFamily;
const validateDataFamily = ownerCodec.validateFamily;
const encodeDataScope = ownerCodec.encodeScope;
function sameDataFamily(left, right) {
  return encodeDataFamily(left) === encodeDataFamily(right);
}
function familyForUser(scope, user, projectId) {
  const projected = projectAccountUser(user);
  return validateDataFamily({
    scope,
    actor: projected
      ? projectId
        ? { kind: 'firebase-hosted', projectId, uid: projected.uid }
        : { kind: 'firebase', uid: projected.uid }
      : { kind: 'local' },
  });
}
function projectAccountUser(user) {
  if (user === null) return null;
  if (!object(user)) throw new Error('The account identity is unavailable.');
  encodeDataFamily({
    scope: { kind: 'canonical' },
    actor: { kind: 'firebase', uid: user.uid },
  });
  for (const [key, max] of [
    ['email', 320],
    ['displayName', 80],
  ]) {
    if (
      user[key] !== null &&
      (typeof user[key] !== 'string' ||
        user[key].length > max ||
        /[\u0000-\u001f\u007f]/.test(user[key]))
    )
      throw new Error('The account identity is unavailable.');
  }
  return { uid: user.uid, email: user.email, displayName: user.displayName };
}
function normalizeDisplayName(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 80 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error('Enter a display name from 1 to 80 characters.');
  return value.trim();
}
function normalizeCredentials(value) {
  if (!object(value) || typeof value.email !== 'string' || typeof value.password !== 'string')
    throw new Error('Enter an email address and password.');
  const email = value.email.trim();
  if (
    !email ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    value.password.length === 0 ||
    value.password.length > 4096
  )
    throw new Error('Enter an email address and password.');
  return { email, password: value.password };
}
function safeAuthMessage(error, operation) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(code))
    return 'The email address or password was not accepted.';
  if (code === 'auth/email-already-in-use')
    return 'That address already has an account. Sign in or use password reset.';
  if (code === 'auth/weak-password') return 'Choose a stronger password and try again.';
  if (code === 'auth/network-request-failed')
    return 'The account service could not be reached. Your saved wallets are retained.';
  if (code === 'auth/too-many-requests')
    return 'The account service is temporarily limiting requests. Recheck before trying again.';
  return operation === 'profile'
    ? 'The display name update was not confirmed. Recheck the profile before trying again.'
    : 'The account request was not confirmed. Recheck the current session before trying again.';
}
module.exports = {
  encodeDataFamily,
  validateDataFamily,
  encodeDataScope,
  sameDataFamily,
  familyForUser,
  projectAccountUser,
  normalizeDisplayName,
  normalizeCredentials,
  safeAuthMessage,
};
