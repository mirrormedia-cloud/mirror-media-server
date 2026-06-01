export function normalize_cookie_input(input: string | null | undefined): string {
    if (!input) return "";
    let raw = String(input).trim();
    if (!raw) return "";

    // If a Netscape-format file content was pasted (lines starting with # or domain TAB lines),
    // extract name=value pairs.
    if (raw.includes("\t") || raw.startsWith("#")) {
        const pairs: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const cols = trimmed.split("\t");
            if (cols.length >= 7) {
                const name = cols[5];
                const value = cols[6];
                if (name) pairs.push(`${name}=${value ?? ""}`);
            }
        }
        if (pairs.length) return pairs.join("; ");
    }

    // Treat newline-separated entries as separate cookies
    raw = raw.replace(/\r?\n+/g, "; ");

    // Collapse multiple semicolons / whitespace
    return raw
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean)
        .join("; ");
}

export function get_cookie_names(cookie_string: string | null | undefined): string[] {
    if (!cookie_string) return [];
    return cookie_string
        .split(";")
        .map((p) => p.trim().split("=")[0]?.trim())
        .filter((n): n is string => Boolean(n));
}

export function mask_cookie_debug(cookie_string: string | null | undefined) {
    const value = cookie_string || "";
    return {
        cookie_status: value ? "available" : "missing",
        cookie_length: value.length,
        cookie_names: get_cookie_names(value),
    };
}
