import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
    CreateOttApiNodeDto,
    UpdateOttApiNodeDto,
    SaveSelectedFieldsDto,
    CallFromCardDto,
    SyncOttDto,
    SaveCardConfigDto,
    CardsFromContextQueryDto,
    CaptureMappingDto,
    CallApiNodeDto,
    TestPaginationDto,
} from "./ott_api.dto";
import {
    get_api_tree,
    create_api_node,
    update_api_node,
    delete_api_node,
    get_api_node,
    call_api_node,
    call_api_from_card,
    sync_ott_apis,
    save_selected_fields,
    get_selected_fields,
    get_api_response,
    get_api_cards,
    get_ott_cards,
    get_card_config,
    save_card_config,
    get_cards_from_context,
    sample_call,
    get_capture_mapping,
    save_capture_mapping,
    test_pagination,
} from "./ott_api.service";
import { validate } from "../../shared/http/validate";
import { HttpStatus } from "../../shared/http/status";
import { serverError } from "../../shared/http/response";

const wrap = (fn: (req: FastifyRequest, res: FastifyReply) => Promise<any>) =>
    async (req: FastifyRequest, res: FastifyReply) => {
        try {
            const result = await fn(req, res);
            const code = result?.success?.code || result?.error?.code;
            res.status(code).send(result);
        } catch (err) {
            console.log("Error:- ott_api.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const ottApiRoutes: FastifyPluginAsync = async (app) => {
    // API tree
    app.get("/:ott_id/apis", wrap(get_api_tree));
    app.post("/:ott_id/apis", { preHandler: validate(CreateOttApiNodeDto) }, wrap(create_api_node));
    app.get("/:ott_id/apis/:api_id", wrap(get_api_node));
    app.put("/:ott_id/apis/:api_id", { preHandler: validate(UpdateOttApiNodeDto) }, wrap(update_api_node));
    app.delete("/:ott_id/apis/:api_id", wrap(delete_api_node));

    // Calling
    app.post(
        "/:ott_id/apis/:api_id/call",
        { preHandler: validate(CallApiNodeDto) },
        wrap(call_api_node),
    );
    app.post(
        "/:ott_id/apis/:api_id/call_from_card",
        { preHandler: validate(CallFromCardDto) },
        wrap(call_api_from_card),
    );
    // Dry-run the configured pagination for the first N pages (cap=2) without
    // persisting anything — lets the user verify config before a real sync.
    app.post(
        "/:ott_id/apis/:api_id/test_pagination",
        { preHandler: validate(TestPaginationDto) },
        wrap(test_pagination),
    );
    // One-shot sample call: works for root APIs (just calls them) and child APIs
    // (auto-resolves parent + first card) so the card builder can fetch fields.
    app.post("/:ott_id/apis/:api_id/sample_call", wrap(sample_call));
    app.post("/:ott_id/sync", { preHandler: validate(SyncOttDto) }, wrap(sync_ott_apis));

    // Selected fields
    app.get("/:ott_id/apis/:api_id/fields", wrap(get_selected_fields));
    app.put(
        "/:ott_id/apis/:api_id/fields",
        { preHandler: validate(SaveSelectedFieldsDto) },
        wrap(save_selected_fields),
    );

    // Response + cards
    app.get("/:ott_id/apis/:api_id/response", wrap(get_api_response));
    app.get("/:ott_id/apis/:api_id/cards", wrap(get_api_cards));
    app.get("/:ott_id/cards", wrap(get_ott_cards));

    // Card config (combined list_path + fields + quick_run + default child + display settings)
    app.get("/:ott_id/apis/:api_id/card_config", wrap(get_card_config));
    app.put(
        "/:ott_id/apis/:api_id/card_config",
        { preHandler: validate(SaveCardConfigDto) },
        wrap(save_card_config),
    );

    // Build cards from a saved child item response (used by recursive renderer).
    app.get(
        "/:ott_id/apis/:api_id/cards_from_context",
        { preHandler: validate(CardsFromContextQueryDto, "query") },
        wrap(get_cards_from_context),
    );

    // Capture mapping (URL/title/thumbnail paths stored once per API for reuse).
    app.get("/:ott_id/apis/:api_id/capture_mapping", wrap(get_capture_mapping));
    app.put(
        "/:ott_id/apis/:api_id/capture_mapping",
        { preHandler: validate(CaptureMappingDto) },
        wrap(save_capture_mapping),
    );
};
