export function get_value_by_path(obj: any, path: string): any {
    if (obj === null || obj === undefined || !path) return undefined;
    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
    let current: any = obj;
    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        if (Array.isArray(current)) {
            const idx = parseInt(part, 10);
            if (Number.isNaN(idx)) return undefined;
            current = current[idx];
            continue;
        }
        current = current[part];
    }
    return current;
}

export function replace_array_index_in_path(path: string, index: number): string {
    return path.replace(/\[0\]/g, `[${index}]`);
}

const VARIABLE_RE = /<([a-zA-Z_][a-zA-Z0-9_]*)>|\{([a-zA-Z_][a-zA-Z0-9_]*)\}|(?:^|[^:/])(:([a-zA-Z_][a-zA-Z0-9_]*))/g;

/** Extract endpoint variables from `<name>`, `{name}`, or `:name` placeholders. */
export function extract_endpoint_variables(endpoint: string): string[] {
    if (!endpoint) return [];
    const out = new Set<string>();
    let match: RegExpExecArray | null;
    const re = new RegExp(VARIABLE_RE.source, "g");
    while ((match = re.exec(endpoint)) !== null) {
        const name = match[1] || match[2] || match[4];
        if (name) out.add(name);
    }
    return Array.from(out);
}

/** Replace `<name>`, `{name}`, and `:name` occurrences with the supplied values (URI-encoded). */
export function resolve_endpoint_variables(endpoint: string, values: Record<string, any>): string {
    if (!endpoint) return endpoint;
    let resolved = endpoint;
    for (const [name, raw] of Object.entries(values)) {
        if (raw === undefined || raw === null) continue;
        const encoded = encodeURIComponent(String(raw));
        resolved = resolved.replace(new RegExp(`<${name}>`, "g"), encoded);
        resolved = resolved.replace(new RegExp(`\\{${name}\\}`, "g"), encoded);
        // For :name match, only replace when preceded by start-of-string or a non-(":"/"/")
        // character followed by ":". We use a callback to keep the boundary char intact.
        resolved = resolved.replace(
            new RegExp(`(^|[^:/]):${name}(?![a-zA-Z0-9_])`, "g"),
            (_full, before) => `${before}${encoded}`,
        );
    }
    return resolved;
}

export function find_array_paths(obj: any, prefix = "", out: string[] = []): string[] {
    if (obj === null || obj === undefined) return out;
    if (Array.isArray(obj)) {
        out.push(prefix || "");
        if (obj.length > 0) find_array_paths(obj[0], `${prefix}[0]`, out);
    } else if (typeof obj === "object") {
        for (const key of Object.keys(obj)) {
            const next = prefix ? `${prefix}.${key}` : key;
            find_array_paths(obj[key], next, out);
        }
    }
    return out;
}

export function extract_field_paths_from_array_item(response: any, list_path: string): string[] {
    const arr = list_path ? get_value_by_path(response, list_path) : response;
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const first = arr[0];
    if (first === null || typeof first !== "object") return [];

    const prefix = list_path ? `${list_path}[0]` : "[0]";
    const paths: string[] = [];

    const walk = (val: any, path: string) => {
        if (val === null || val === undefined) return;
        if (Array.isArray(val)) {
            paths.push(path);
            if (val.length > 0) walk(val[0], `${path}[0]`);
            return;
        }
        if (typeof val === "object") {
            for (const key of Object.keys(val)) {
                const next = `${path}.${key}`;
                paths.push(next);
                walk(val[key], next);
            }
        } else {
            // scalar leaves are reachable via the parent path; nothing else to add
        }
    };

    walk(first, prefix);
    return Array.from(new Set(paths));
}

export function is_image_url(value: any): boolean {
    if (typeof value !== "string") return false;
    if (!/^https?:\/\//i.test(value)) return false;
    return /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?.*)?$/i.test(value)
        || /\/image\//i.test(value)
        || /thumb|poster|cover|banner|image/i.test(value);
}

export interface SelectedFieldDef {
    path: string;
    label?: string | null;
    display_type: string;
    sort_order: number;
    is_visible?: boolean;
}

export interface CardField {
    path: string;
    label: string | null;
    display_type: string;
    value: any;
}

export interface BuiltCard {
    index: number;
    item_key: string;
    fields: CardField[];
    raw_item: any;
}

export function get_item_key(raw_item: any, selected_fields: SelectedFieldDef[], fallback_index: number): string {
    if (raw_item && typeof raw_item === "object") {
        const hidden = selected_fields.find((f) => f.display_type === "hidden_id");
        if (hidden) {
            const stripped = hidden.path.replace(/^[^[.]+\[0\]\.?/, "").replace(/^[^[.]+\.?/, "");
            const lastSegment = stripped || hidden.path.split(".").pop() || "";
            const direct = lastSegment ? raw_item[lastSegment] : undefined;
            if (direct !== undefined && direct !== null) return String(direct);
        }
        for (const candidate of ["id", "_id", "uuid", "slug", "key"]) {
            if (raw_item[candidate] !== undefined && raw_item[candidate] !== null) {
                return String(raw_item[candidate]);
            }
        }
    }
    return `index_${fallback_index}`;
}

export function build_cards_from_response(
    response: any,
    list_path: string | null | undefined,
    selected_fields: SelectedFieldDef[],
): BuiltCard[] {
    if (!response) return [];
    const visible_fields = selected_fields
        .filter((f) => f.is_visible !== false)
        .sort((a, b) => a.sort_order - b.sort_order);

    const arr = list_path ? get_value_by_path(response, list_path) : response;
    if (!Array.isArray(arr)) return [];

    return arr.map((raw_item, index) => {
        const fields: CardField[] = visible_fields.map((f) => ({
            path: f.path,
            label: f.label ?? null,
            display_type: f.display_type,
            value: get_value_by_path(response, replace_array_index_in_path(f.path, index)),
        }));
        return {
            index,
            item_key: get_item_key(raw_item, selected_fields, index),
            fields,
            raw_item,
        };
    });
}
