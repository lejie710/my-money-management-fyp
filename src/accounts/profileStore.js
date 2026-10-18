const { validDate } = require("../core/model");
const { validateDataFamily, encodeDataFamily } = require("./identity");
const GENDERS = Object.freeze([
  "",
  "female",
  "male",
  "nonbinary",
  "prefer-not-to-say",
]);
const EMPTY_PROFILE_EXTRAS = Object.freeze({ gender: "", birthDate: null });
function validateProfileExtras(value, today) {
  if (
    !validDate(today) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "birthDate,gender" ||
    !GENDERS.includes(value.gender) ||
    (value.birthDate !== null &&
      (!validDate(value.birthDate) || value.birthDate > today))
  )
    throw new Error(
      "Choose optional profile details with a valid birthday no later than today.",
    );
  return { gender: value.gender, birthDate: value.birthDate };
}
function createProfileStore(adapter, value, today) {
  const family = validateDataFamily(value),
    token = encodeDataFamily(family);
  if (family.actor.kind !== "firebase")
    throw new Error("Local account profile details require an account family.");
  const key = `@mymoney/account-profile/v1/${encodeURIComponent(token)}`;
  async function load() {
    const raw = await adapter.getItem(key);
    if (raw === null) return null;
    const stored = JSON.parse(raw);
    if (
      !stored ||
      Object.keys(stored).sort().join(",") !== "extras,family,version" ||
      stored.version !== 1 ||
      encodeDataFamily(stored.family) !== token
    )
      throw new Error(
        "The saved profile details have invalid ownership or format.",
      );
    return validateProfileExtras(stored.extras, today());
  }
  async function save(extras) {
    const captured = validateProfileExtras(extras, today()),
      raw = JSON.stringify({ version: 1, family, extras: captured });
    try {
      await adapter.setItem(key, raw);
      return {
        ok: true,
        pending: false,
        extras: captured,
        message: "Local profile details saved.",
      };
    } catch {
      try {
        const observed = await load();
        if (observed && JSON.stringify(observed) === JSON.stringify(captured))
          return {
            ok: true,
            pending: false,
            extras: observed,
            message: "Local profile details confirmed by reopening saved data.",
          };
        return {
          ok: false,
          pending: false,
          extras: observed,
          message:
            "The requested profile change was not confirmed. Saved details were reopened.",
        };
      } catch {
        return {
          ok: false,
          pending: true,
          extras: null,
          message:
            "The profile save outcome could not be confirmed. Reopen the saved details before editing again.",
        };
      }
    }
  }
  return { key, load, save };
}
module.exports = {
  GENDERS,
  EMPTY_PROFILE_EXTRAS,
  validateProfileExtras,
  createProfileStore,
};
