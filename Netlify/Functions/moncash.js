/* ====================================
   BAZIK.IO MONCASH - BIZEN HT
   Based on official Bazik documentation
   ==================================== */

const https = require('https');

/* ====================================
   CONFIG - From environment variables
   ==================================== */
var BAZIK_USER_ID =
    process.env.BAZIK_USER_ID || "";

var BAZIK_SECRET =
    process.env.BAZIK_SECRET || "";

var BAZIK_HOST = "api.bazik.io";

var SITE_URL = "https://bizenht.com";

/* ====================================
   CORS HEADERS
   ==================================== */
var CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
        'Content-Type',
    'Access-Control-Allow-Methods':
        'POST, OPTIONS',
    'Content-Type': 'application/json'
};

/* ====================================
   HTTP HELPER
   ==================================== */
function doRequest(options, body) {
    return new Promise(function(
        resolve, reject
    ) {
        var req = https.request(
            options,
            function(res) {
                var chunks = [];
                res.on('data', function(c) {
                    chunks.push(c);
                });
                res.on('end', function() {
                    var raw =
                        Buffer.concat(chunks)
                        .toString();
                    console.log(
                        "[HTTP]",
                        options.method,
                        options.hostname +
                        options.path,
                        "->",
                        res.statusCode
                    );
                    console.log(
                        "[BODY]",
                        raw.substring(0, 300)
                    );
                    try {
                        resolve(
                            JSON.parse(raw)
                        );
                    } catch(e) {
                        resolve({
                            _raw: raw,
                            _status: res.statusCode
                        });
                    }
                });
            }
        );
        req.on('error', function(err) {
            console.error(
                "[REQUEST ERROR]",
                err.message
            );
            reject(err);
        });
        req.setTimeout(30000, function() {
            req.destroy();
            reject(new Error("Timeout"));
        });
        if (body) {
            req.write(body);
        }
        req.end();
    });
}

/* ====================================
   STEP 1 - GET AUTH TOKEN
   POST /token
   ==================================== */
async function getToken() {
    console.log(
        "[TOKEN] Getting token for:",
        BAZIK_USER_ID
    );

    if (!BAZIK_USER_ID || !BAZIK_SECRET) {
        throw new Error(
            "Missing BAZIK_USER_ID or " +
            "BAZIK_SECRET env variables"
        );
    }

    var bodyObj = {
        userID: BAZIK_USER_ID,
        secretKey: BAZIK_SECRET
    };
    var bodyStr = JSON.stringify(bodyObj);

    var options = {
        hostname: BAZIK_HOST,
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
            'Content-Type':
                'application/json',
            'Content-Length':
                Buffer.byteLength(bodyStr)
        }
    };

    var result = await doRequest(
        options, bodyStr
    );

    console.log("[TOKEN RESULT]", result);

    if (!result.access_token) {
        throw new Error(
            "No access_token received. " +
            "Response: " +
            JSON.stringify(result)
        );
    }

    console.log("[TOKEN] Success ✅");
    return result.access_token;
}

/* ====================================
   STEP 2 - CREATE MONCASH PAYMENT
   POST /moncash/token
   (as shown in Bazik docs)
   ==================================== */
async function createMoncashPayment(
    amount,
    referenceId,
    customerEmail,
    customerFirstName,
    customerLastName,
    userId
) {
    var token = await getToken();

    console.log(
        "[PAYMENT] Creating payment:",
        referenceId,
        "Amount:", amount,
        "Gdes"
    );

    var bodyObj = {
        gdes: parseFloat(amount),
        userID: BAZIK_USER_ID,
        successUrl: SITE_URL +
            "/?payment=success&ref=" +
            referenceId,
        errorUrl: SITE_URL +
            "/?payment=error&ref=" +
            referenceId,
        description:
            "Bizen HT - Membership Premium",
        referenceId: referenceId,
        customerFirstName:
            customerFirstName || "Client",
        customerLastName:
            customerLastName || "Bizen",
        customerEmail:
            customerEmail || "",
        webhookUrl: SITE_URL +
            "/.netlify/functions/webhook",
        metadata: {
            userId: userId || "",
            email: customerEmail || "",
            product: "premium_membership",
            site: "bizenht.com"
        }
    };

    var bodyStr = JSON.stringify(bodyObj);

    var options = {
        hostname: BAZIK_HOST,
        port: 443,
        path: '/moncash/token',
        method: 'POST',
        headers: {
            'Content-Type':
                'application/json',
            'Content-Length':
                Buffer.byteLength(bodyStr),
            'Authorization':
                'Bearer ' + token
        }
    };

    var result = await doRequest(
        options, bodyStr
    );

    console.log("[PAYMENT RESULT]", result);
    return result;
}

/* ====================================
   STEP 3 - VERIFY PAYMENT
   ==================================== */
async function verifyPayment(referenceId) {
    var token = await getToken();

    console.log(
        "[VERIFY] Checking:", referenceId
    );

    /* Try different verify endpoints */
    var endpoints = [
        '/moncash/verify/' + referenceId,
        '/payment/verify/' + referenceId,
        '/payment/' + referenceId + '/status',
        '/moncash/status/' + referenceId
    ];

    for (var i = 0;
         i < endpoints.length; i++) {
        try {
            var options = {
                hostname: BAZIK_HOST,
                port: 443,
                path: endpoints[i],
                method: 'GET',
                headers: {
                    'Authorization':
                        'Bearer ' + token,
                    'Content-Type':
                        'application/json'
                }
            };

            var result = await doRequest(
                options, null
            );

            console.log(
                "[VERIFY] Result from",
                endpoints[i], ":", result
            );

            /* Check various success states */
            if (
                result.status === 'success' ||
                result.status === 'completed' ||
                result.status === 'paid' ||
                result.paid === true ||
                result.success === true
            ) {
                return {
                    verified: true,
                    status: result.status ||
                        'success',
                    raw: result
                };
            }

            if (result.status) {
                return {
                    verified: false,
                    status: result.status,
                    raw: result
                };
            }
        } catch(e) {
            console.log(
                "[VERIFY] Endpoint",
                endpoints[i],
                "failed:", e.message
            );
        }
    }

    return {
        verified: false,
        status: 'unknown'
    };
}

/* ====================================
   MAIN HANDLER
   ==================================== */
exports.handler = async function(
    event, context
) {
    /* Handle CORS preflight */
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: CORS,
            body: ''
        };
    }

    /* Only POST */
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: CORS,
            body: JSON.stringify({
                success: false,
                error: 'Method Not Allowed'
            })
        };
    }

    try {
        var body = JSON.parse(
            event.body || '{}'
        );
        var action = body.action;

        console.log(
            "=== REQUEST ===",
            "Action:", action
        );

        /* ============================
           TEST CONNECTION
           ============================ */
        if (action === 'test') {
            try {
                var token = await getToken();
                return {
                    statusCode: 200,
                    headers: CORS,
                    body: JSON.stringify({
                        success: true,
                        message:
                            "Bazik.io konekte! " +
                            "Peman pret.",
                        userId: BAZIK_USER_ID,
                        hasToken: true
                    })
                };
            } catch(testErr) {
                return {
                    statusCode: 200,
                    headers: CORS,
                    body: JSON.stringify({
                        success: false,
                        error: testErr.message,
                        hint:
                            "Check env vars: " +
                            "BAZIK_USER_ID and " +
                            "BAZIK_SECRET"
                    })
                };
            }
        }

        /* ============================
           CREATE PAYMENT
           ============================ */
        if (action === 'create') {
            var amount =
                body.amount || 1000;
            var userId =
                body.userId || "";
            var userEmail =
                body.userEmail || "";
            var firstName =
                body.firstName || "Client";
            var lastName =
                body.lastName || "Bizen";

            /* Generate unique reference */
            var referenceId =
                'BHT' +
                Date.now().toString(36)
                    .toUpperCase() +
                Math.random()
                    .toString(36)
                    .substr(2, 4)
                    .toUpperCase();

            console.log(
                "[CREATE] Reference:",
                referenceId
            );

            var payment =
                await createMoncashPayment(
                    amount,
                    referenceId,
                    userEmail,
                    firstName,
                    lastName,
                    userId
                );

            /* Extract payment URL from
               various possible fields */
            var paymentUrl =
                payment.paymentUrl ||
                payment.payment_url ||
                payment.redirect_url ||
                payment.redirectUrl ||
                payment.url ||
                payment.link ||
                payment.redirectLink ||
                payment.payUrl ||
                null;

            /* If MonCash token returned,
               build redirect URL */
            if (!paymentUrl &&
                (payment.token ||
                 payment.moncash_token)) {
                var tk =
                    payment.token ||
                    payment.moncash_token;
                /* Production MonCash URL */
                paymentUrl =
                    'https://moncashbutton' +
                    '.digicelgroup.com/' +
                    'Moncash-middleware/' +
                    'Payment/Redirect?token=' +
                    tk;
            }

            console.log(
                "[CREATE] Payment URL:",
                paymentUrl
            );

            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({
                    success: !!paymentUrl,
                    referenceId: referenceId,
                    paymentUrl: paymentUrl,
                    rawResponse: payment
                })
            };
        }

        /* ============================
           VERIFY PAYMENT
           ============================ */
        if (action === 'verify') {
            var refId =
                body.referenceId ||
                body.orderId;

            if (!refId) {
                return {
                    statusCode: 400,
                    headers: CORS,
                    body: JSON.stringify({
                        success: false,
                        error: 'referenceId requis'
                    })
                };
            }

            var verifyResult =
                await verifyPayment(refId);

            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({
                    success: true,
                    verified:
                        verifyResult.verified,
                    status: verifyResult.status
                })
            };
        }

        /* Unknown action */
        return {
            statusCode: 400,
            headers: CORS,
            body: JSON.stringify({
                success: false,
                error: 'Action invalide: ' +
                    action
            })
        };

    } catch(error) {
        console.error(
            "[HANDLER ERROR]",
            error.message
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