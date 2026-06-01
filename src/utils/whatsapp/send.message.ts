import { config } from "../../config";

/**
 * Send an arbitrary free-text WhatsApp message via the Cloud API.
 *
 * IMPORTANT — 24-hour customer service window: Meta only allows free-text
 * (`type: "text"`) messages to numbers that have messaged your business in
 * the last 24 hours. Outside that window the API returns error code 131047
 * ("Message failed to send because more than 24 hours have passed since the
 * customer last replied to this number") and you must use an approved
 * template instead. If you need to initiate conversations from cold, use a
 * template-based sender.
 *
 * @param to       Recipient in E.164 without the leading `+` (e.g. "919265739309").
 * @param text     The exact message body the recipient will see.
 * @param preview_url  Optional — when true and `text` contains a URL, WhatsApp
 *                     renders a link preview card. Defaults to false.
 */
export async function sendWhatsappTextMessage(to: string, text: string, preview_url: boolean = false) {
    try {
        const { access_token: token, phone_number_id: phoneNumberId, api_version } = config.whatsapp;

        if (!token) {
            throw new Error("WHATSAPP_ACCESS_TOKEN is missing in .env");
        }

        if (!phoneNumberId) {
            throw new Error("WHATSAPP_PHONE_NUMBER_ID is missing in .env");
        }

        const url = `https://graph.facebook.com/${api_version}/${phoneNumberId}/messages`;

        const body = {
            messaging_product: "whatsapp",
            // recipient_type: "individual",
            to,
            type: "text",
            text: {
                preview_url,
                body: text,
            },
        };

        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        const data: any = await response.json();

        if (!response.ok) {
            console.error("[WHATSAPP_SEND_FAILED]", data);
            throw new Error(data?.error?.message || "WhatsApp message send failed");
        }

        console.log("[WHATSAPP_SEND_SUCCESS]", data);
        return { status: true, data, message: 'message sent!' };
    } catch (error: any) {
        console.log('Error from sent wp msg:- ', error);
        return { status: false, message: error?.message || error };
    }
}
