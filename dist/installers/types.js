/** `true`/"latest" always satisfies an installed tool; otherwise prefix-match. */
export function satisfiesDesired(desired, version) {
    if (!version)
        return false;
    if (desired === true)
        return true;
    return version.trim().startsWith(desired.trim());
}
//# sourceMappingURL=types.js.map