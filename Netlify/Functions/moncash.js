const https = require('https');
const BUILD_VERSION =
    "moncash-dynamic-amount-v3";
const crypto = require('crypto');

/* ====================================
   CONFIG
   ==================================== */
const BAZIK_USER_ID =
    process.env.BAZIK_USER_ID || "";

const BAZIK_SECRET =
    process.env.BAZIK_SECRET || "";

const BAZIK_HOST = "api.bazik.io";
const SITE_URL = "https://bizenht.com";

/* ====================================
   CORS
   ==================================== */
const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "Content-Type",
    "Access-Control-Allow-Methods":
        "POST, OPTIONS",
    "Content-Type": "application/json"
};

/* ====================================
   HTTP REQUEST HELPER (avec retry sur 503)
   ==================================== */
function doRequest(options, body) {
    return attempt(1);

    function attempt(n) {
        return new Promise(function (resolve, reject) {
            const req = https.request(options, function (res) {
                let raw = "";
                res.on("data", function (chunk) { raw += chunk; });
                res.on("end", function () {
                    console.log("[HTTP]", options.method, options.path,
                        "->", res.statusCode, "(eseye " + n + ")");
                    console.log("[RAW]", raw.substring(0, 500));

                    /* Erreurs serveur transitoires => on réessaie */
                    if ([502, 503, 504].indexOf(res.statusCode) !== -1 && n < 3) {
                        console.log("[RETRY] " + res.statusCode + " transitwa, re-eseye...");
                        return setTimeout(function () {
                            attempt(n + 1).then(resolve, reject);
                        }, 800 * n);
                    }

                    try {
                        resolve({ statusCode: res.statusCode, data: JSON.parse(raw) });
                    } catch (e) {
                        resolve({ statusCode: res.statusCode, data: raw });
                    }
                });
            });

            req.on("error", function (err) {
                /* Erreur réseau => on réessaie aussi */
                if (n < 3) {
                    console.log("[RETRY] erè rezo, re-eseye...", err.message);
                    return setTimeout(function () {
                        attempt(n + 1).then(resolve, reject);
                    }, 800 * n);
                }
                reject(err);
            });

            req.setTimeout(8000, function () {
                req.destroy(new Error("Request timeout"));

            });

            if (body) req.write(body);
            req.end();
        });
    }
}

/* ====================================
   GET AUTH TOKEN
   BAZIK RETURNS "token", NOT "access_token"
   ==================================== */
async function getToken() {
    if (!BAZIK_USER_ID || !BAZIK_SECRET) {
        throw new Error(
            "Missing Netlify env vars: " +
            "BAZIK_USER_ID / BAZIK_SECRET"
        );
    }

    const body = JSON.stringify({
        userID: BAZIK_USER_ID,
        secretKey: BAZIK_SECRET
    });

    const options = {
        hostname: BAZIK_HOST,
        port: 443,
        path: "/token",
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length":
                Buffer.byteLength(body)
        }
    };

    const result = await doRequest(
        options, body
    );

    console.log(
        "[TOKEN RESULT]",
        result.data
    );

    const token =
        result.data &&
        (result.data.token ||
         result.data.access_token);

    if (!token) {
        throw new Error(
            "No token received. Response: " +
            JSON.stringify(result.data)
        );
    }

    return token;
}

/* ====================================
   CREATE MONCASH PAYMENT
   POST /moncash/token
   --> Montant dynamique (gdes = payload.amount)
   --> Distingue "premium" vs "reservation"
   ==================================== */
async function createPayment(payload) {
    const token = await getToken();

    /* NOUVEAU: type de paiement (premium par défaut) */
    const isReservation =
        payload.purpose === "reservation";

    /* NOUVEAU: libellé + URL de retour adaptés */
    const description = isReservation
        ? "Bizen HT - Rezevasyon Elu"
        : "Bizen HT - Membership Premium";

    const successUrl =
        SITE_URL +
        "/?payment=success&ref=" +
        payload.referenceId +
        (isReservation
            ? "&resId=" +
              (payload.reservationId || "")
            : "");

    const body = JSON.stringify({
        gdes: parseFloat(payload.amount),
        userID: payload.userId || crypto.randomUUID(),
        successUrl: successUrl,
        description: description,
        referenceId: payload.referenceId,
        errorUrl:
    SITE_URL +
    "/?payment=error&ref=" +
    payload.referenceId,
        customerFirstName:
            payload.firstName || "Client",
        customerLastName:
            payload.lastName || "Bizen",
        customerEmail:
            payload.email || "",
        webhookUrl:
            SITE_URL +
            "/.netlify/functions/webhook",
        metadata: {
            firebaseUserId:
    payload.firebaseUserId ||
    payload.userId || "",
            firebaseEmail:
                payload.email || "",
            site: "bizenht.com",
            product: isReservation
                ? "reservation"
                : "premium",
            purpose:
                payload.purpose || "premium",
            reservationId:
                payload.reservationId || ""
        }
    });

    const options = {
        hostname: BAZIK_HOST,
        port: 443,
        path: "/moncash/token",
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization":
                "Bearer " + token,
            "Content-Length":
                Buffer.byteLength(body)
        }
    };

    const result = await doRequest(
        options, body
    );

    console.log(
        "[PAYMENT RESULT]",
        result.data
    );

    return result.data;
}

/* ====================================
   VERIFY PAYMENT
   ==================================== */
async function verifyPayment(referenceId) {
    const token = await getToken();

    const endpoints = [
        "/moncash/verify/" + referenceId,
        "/payment/verify/" + referenceId,
        "/payment/" + referenceId,
        "/moncash/" + referenceId
    ];

    for (let i = 0; i < endpoints.length; i++) {
        try {
            const options = {
                hostname: BAZIK_HOST,
                port: 443,
                path: endpoints[i],
                method: "GET",
                headers: {
                    "Authorization":
                        "Bearer " + token,
                    "Content-Type":
                        "application/json"
                }
            };

            const result =
                await doRequest(
                    options, null
                );

            const data = result.data || {};

            const verified =
                data.status === "success" ||
                data.status === "completed" ||
                data.status === "paid" ||
                data.success === true ||
                data.paid === true;

            if (
                data.status ||
                data.success ||
                data.paid
            ) {
                return {
                    verified: verified,
                    status:
                        data.status || "unknown",
                    raw: data
                };
            }
        } catch (e) {
            console.log(
                "[VERIFY FAIL]",
                endpoints[i],
                e.message
            );
        }
    }

    return {
        verified: false,
        status: "unknown"
    };
}

/* ====================================
   HANDLER
   ==================================== */
exports.handler = async function(
    event, context
) {
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 200,
            headers: CORS,
            body: ""
        };
    }

    try {
        const body = JSON.parse(
            event.body || "{}"
        );
        const action = body.action;

        console.log(
            "=== ACTION ===",
            action
        );

        /* TEST */
        if (action === "test") {
            try {
                const token = await getToken();
                return {
                    statusCode: 200,
                    headers: CORS,
                    body: JSON.stringify({
                        success: true,
                        message:
                            "Bazik.io konekte! " +
                            "Peman pret.",
                        hasToken: !!token
                    })
                };
            } catch (e) {
                return {
                    statusCode: 200,
                    headers: CORS,
                    body: JSON.stringify({
                        success: false,
                        error: e.message
                    })
                };
            }
        }

        /* CREATE PAYMENT */
        if (action === "create") {
            const referenceId =
                "BHT-" +
                Date.now() + "-" +
                Math.random()
                    .toString(36)
                    .substr(2, 6)
                    .toUpperCase();

            const result =
                await createPayment({
                    amount:
                        body.amount || 1000,
                    userId:
                        body.userId || "",
                    firebaseUserId:
                        body.userId || "",
                    email:
                        body.userEmail || "",
                    firstName:
                        body.firstName ||
                        "Client",
                    lastName:
                        body.lastName ||
                        "Bizen",
                    referenceId:
                        referenceId,
                    /* NOUVEAU: type + id réservation */
                    purpose:
                        body.purpose ||
                        "premium",
                    reservationId:
                        body.reservationId ||
                        ""
                });

            /* Try to extract payment URL */
            const paymentUrl =
                result.paymentUrl ||
                result.payment_url ||
                result.redirectUrl ||
                result.redirect_url ||
                result.url ||
                result.link ||
                result.token ||
                null;

            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({
                    success: !!paymentUrl,
                    referenceId: referenceId,
                    paymentUrl: paymentUrl,
                    rawResponse: result
                })
            };
        }

        /* VERIFY PAYMENT */
        if (action === "verify") {
            const referenceId =
                body.referenceId ||
                body.orderId;

            if (!referenceId) {
                return {
                    statusCode: 400,
                    headers: CORS,
                    body: JSON.stringify({
                        success: false,
                        error:
                            "referenceId requis"
                    })
                };
            }

            const result =
                await verifyPayment(
                    referenceId
                );

            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({
                    success: true,
                    verified:
                        result.verified,
                    status: result.status,
                    raw: result.raw
                })
            };
        }

        return {
            statusCode: 400,
            headers: CORS,
            body: JSON.stringify({
                success: false,
                error: "Action invalide"
            })
        };

    } catch (error) {
        console.error(
            "[HANDLER ERROR]",
            error
        );
        return {
            statusCode: 500,
            headers: CORS,
            body: JSON.stringify({
                success: false,
                error: error.message
            })
        };
    }
};
