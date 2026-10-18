'use strict';

// Pure identity codec. It neither reads configuration nor performs storage/network work.
const FAMILY_FORMAT = 'mymoney-data-family-v2';
const OWNER_FORMAT = 'mymoney-wallet-owner-v2';

const keys = (value, names) =>
  object(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const invalid = () => {
  throw new Error('The wallet identity is invalid or unsupported.');
};
function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
function parseToken(token) {
  if (typeof token !== 'string' || !token || token.length > 4096 || /[\u0000-\u001f]/.test(token))
    invalid();
  try {
    return JSON.parse(token);
  } catch {
    invalid();
  }
}

function createProjectIdentityCodec({ legacyIdentity, legacyOwners } = {}) {
  if (
    !legacyIdentity ||
    !legacyOwners ||
    ['encodeDataFamily', 'validateDataFamily', 'encodeDataScope'].some(
      (name) => typeof legacyIdentity[name] !== 'function',
    ) ||
    ['encodeReminderOwner', 'decodeReminderOwner'].some(
      (name) => typeof legacyOwners[name] !== 'function',
    )
  )
    invalid();
  // Capture functions so later changes to the injected container cannot alter this codec.
  const legacy = {
    family: legacyIdentity.encodeDataFamily,
    validateFamily: legacyIdentity.validateDataFamily,
    scope: legacyIdentity.encodeDataScope,
    owner: legacyOwners.encodeReminderOwner,
    decodeOwner: legacyOwners.decodeReminderOwner,
  };
  function validateFamily(value) {
    if (!keys(value, ['scope', 'actor'])) invalid();
    if (value.actor?.kind !== 'firebase-hosted') {
      try {
        return frozen(legacy.validateFamily(value));
      } catch {
        invalid();
      }
    }
    if (
      !keys(value.actor, ['kind', 'projectId', 'uid']) ||
      typeof value.actor.projectId !== 'string' ||
      value.actor.projectId.trim() !== value.actor.projectId ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.actor.projectId)
    )
      invalid();
    try {
      // Reuse the actual scope/UID rules without changing the legacy wire format.
      legacy.family({
        scope: value.scope,
        actor: { kind: 'firebase', uid: value.actor.uid },
      });
    } catch {
      invalid();
    }
    return frozen({
      scope:
        value.scope.kind === 'canonical'
          ? { kind: 'canonical' }
          : { kind: 'test', namespace: value.scope.namespace },
      actor: {
        kind: 'firebase-hosted',
        projectId: value.actor.projectId,
        uid: value.actor.uid,
      },
    });
  }
  function encodeFamily(value) {
    const family = validateFamily(value);
    if (family.actor.kind !== 'firebase-hosted') return legacy.family(family);
    return JSON.stringify({
      format: FAMILY_FORMAT,
      scope: family.scope,
      actor: family.actor,
    });
  }
  function decodeFamily(token) {
    const parsed = parseToken(token);
    let family;
    if (Array.isArray(parsed)) {
      if (parsed.length !== 4) invalid();
      // Explicit legacy format parser; never derive fields by slicing another token.
      const [scopeKind, namespace, actorKind, uid] = parsed;
      if (
        (scopeKind === 'canonical' && namespace !== null) ||
        (actorKind === 'local' && uid !== null)
      )
        invalid();
      family = {
        scope: scopeKind === 'canonical' ? { kind: scopeKind } : { kind: scopeKind, namespace },
        actor: actorKind === 'local' ? { kind: actorKind } : { kind: actorKind, uid },
      };
    } else {
      if (
        !keys(parsed, ['format', 'scope', 'actor']) ||
        parsed.format !== FAMILY_FORMAT ||
        parsed.actor?.kind !== 'firebase-hosted'
      )
        invalid();
      family = { scope: parsed.scope, actor: parsed.actor };
    }
    const confirmed = validateFamily(family);
    if (encodeFamily(confirmed) !== token) invalid();
    return confirmed;
  }
  function validateOwner(value) {
    if (!keys(value, ['scope', 'actor', 'incarnationId'])) invalid();
    const family = validateFamily({ scope: value.scope, actor: value.actor });
    try {
      legacy.owner({
        scope: { kind: 'canonical' },
        actor: { kind: 'local' },
        incarnationId: value.incarnationId,
      });
    } catch {
      invalid();
    }
    return frozen({ ...family, incarnationId: value.incarnationId });
  }
  function encodeOwner(value) {
    const owner = validateOwner(value);
    if (owner.actor.kind !== 'firebase-hosted') return legacy.owner(owner);
    return JSON.stringify({
      format: OWNER_FORMAT,
      scope: owner.scope,
      actor: owner.actor,
      incarnationId: owner.incarnationId,
    });
  }
  function decodeOwner(token) {
    const parsed = parseToken(token);
    let owner;
    if (Array.isArray(parsed)) {
      try {
        owner = legacy.decodeOwner(token);
      } catch {
        invalid();
      }
    } else {
      if (
        !keys(parsed, ['format', 'scope', 'actor', 'incarnationId']) ||
        parsed.format !== OWNER_FORMAT ||
        parsed.actor?.kind !== 'firebase-hosted'
      )
        invalid();
      owner = {
        scope: parsed.scope,
        actor: parsed.actor,
        incarnationId: parsed.incarnationId,
      };
    }
    const confirmed = validateOwner(owner);
    if (encodeOwner(confirmed) !== token) invalid();
    return confirmed;
  }
  function ownerFromFamily(value, incarnationId) {
    return validateOwner({ ...validateFamily(value), incarnationId });
  }
  function familyFromOwner(value) {
    const owner = validateOwner(value);
    return validateFamily({ scope: owner.scope, actor: owner.actor });
  }
  return Object.freeze({
    validateFamily,
    encodeFamily,
    decodeFamily,
    validateOwner,
    encodeOwner,
    decodeOwner,
    ownerFromFamily,
    familyFromOwner,
    encodeScope(scope) {
      try {
        return legacy.scope(scope);
      } catch {
        invalid();
      }
    },
    familyTokenFromOwnerToken(token) {
      return encodeFamily(familyFromOwner(decodeOwner(token)));
    },
    scopeTokenFromFamilyToken(token) {
      return legacy.scope(decodeFamily(token).scope);
    },
    photoFamilyToken(value) {
      return encodeOwner(ownerFromFamily(value, 'photo-family'));
    },
    sameFamily(left, right) {
      return encodeFamily(left) === encodeFamily(right);
    },
    sameOwner(left, right) {
      return encodeOwner(left) === encodeOwner(right);
    },
  });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}
function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
}
function boundedToken(value, maximum = 2048) {
  return text(value, maximum) && !/[\u0000-\u001f]/.test(value);
}
function sameKeys(value, keys) {
  return object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function validateScope(scope) {
  if (sameKeys(scope, ['kind']) && scope.kind === 'canonical') return;
  if (
    sameKeys(scope, ['kind', 'namespace']) &&
    scope.kind === 'test' &&
    boundedToken(scope.namespace, 128)
  )
    return;
  throw new Error('Choose a valid canonical or isolated test reminder scope.');
}

function legacyEncodeOwner(owner) {
  if (!sameKeys(owner, ['scope', 'actor', 'incarnationId']) || !identifier(owner.incarnationId)) {
    throw new Error('The reminder owner requires a valid wallet incarnation.');
  }
  validateScope(owner.scope);
  const actor = owner.actor;
  if (
    !(sameKeys(actor, ['kind']) && actor.kind === 'local') &&
    !(sameKeys(actor, ['kind', 'uid']) && actor.kind === 'firebase' && boundedToken(actor.uid, 128))
  ) {
    throw new Error('Choose a valid local or account reminder owner.');
  }
  return JSON.stringify([
    owner.scope.kind,
    owner.scope.kind === 'test' ? owner.scope.namespace : null,
    actor.kind,
    actor.kind === 'firebase' ? actor.uid : null,
    owner.incarnationId,
  ]);
}

function legacyDecodeOwner(token) {
  if (!boundedToken(token)) throw new Error('The reminder owner token is invalid.');
  let values;
  try {
    values = JSON.parse(token);
  } catch {
    throw new Error('The reminder owner token is invalid.');
  }
  if (!Array.isArray(values) || values.length !== 5)
    throw new Error('The reminder owner token is invalid.');
  const [scopeKind, namespace, actorKind, uid, incarnationId] = values;
  if (
    (scopeKind === 'canonical' && namespace !== null) ||
    (actorKind === 'local' && uid !== null)
  ) {
    throw new Error('The reminder owner token has unexpected context fields.');
  }
  const owner = {
    scope: scopeKind === 'canonical' ? { kind: scopeKind } : { kind: scopeKind, namespace },
    actor: actorKind === 'local' ? { kind: actorKind } : { kind: actorKind, uid },
    incarnationId,
  };
  if (legacyEncodeOwner(owner) !== token)
    throw new Error('The reminder owner token is not canonical.');
  return owner;
}

function legacyFamily(family) {
  if (!sameKeys(family, ['scope', 'actor']))
    throw new Error('An explicit data family is required.');
  legacyEncodeOwner({ ...family, incarnationId: 'account-family' });
  return JSON.stringify([
    family.scope.kind,
    family.scope.kind === 'test' ? family.scope.namespace : null,
    family.actor.kind,
    family.actor.kind === 'firebase' ? family.actor.uid : null,
  ]);
}
const codec = createProjectIdentityCodec({
  legacyIdentity: {
    encodeDataFamily: legacyFamily,
    validateDataFamily(value) {
      legacyFamily(value);
      return JSON.parse(JSON.stringify(value));
    },
    encodeDataScope(scope) {
      validateScope(scope);
      return JSON.stringify([scope.kind, scope.kind === 'test' ? scope.namespace : null]);
    },
  },
  legacyOwners: { encodeReminderOwner: legacyEncodeOwner, decodeReminderOwner: legacyDecodeOwner },
});
module.exports = { ...codec, FAMILY_FORMAT, OWNER_FORMAT };
