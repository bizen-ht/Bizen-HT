/* ====================================
   BAZIK.IO - MONCASH PRODUCTION
   ==================================== */

const https = require('https');

var WEBHOOK_SECRET =
    process.env.BAZIK_WEBHOOK_SECRET || "";

var FIREBASE_PROJECT = "bizen-ht";

var BAZIK_USER_ID =
    process.env.BAZIK_USER_ID || "";

var BAZIK_SECRET =
    process.env.BAZIK_SECRET || "";

var BAZIK_HOST = "api.bazik.io";

var WEBHOOK_URL =
    "https://bizenht.com" +
    "/.netlify/functions/webhook";

var SUCCESS_URL =
    "https://bizenht.com/?payment=success";

var ERROR_URL =
    "https://bizenht.com/?payment=error";

/* ====================================
   HTTP REQUEST
   ==================================== */
function httpReq(options, body) {
    return new Promise(
        function(resolve, reject) {
            var req = https.request(
                options,
                function(res) {
                    var data = '';
                    res.on('data',
                        function(c) {
                            data += c;
                        }
                    );
                    res.on('end',
                        function() {
                            console.log(
                                "HTTP",
                                options.path,
                                "->",
                                res.statusCode
                            );
                            console.log(
                                "Body:",
                                data.substring(
                                    0, 300
                                )
                            );
                            try {
                                resolve(
                                    JSON.parse(data)
                                );
                            } catch(e) {
                                resolve({
                                    raw: data,
                                    statusCode:
                                        res.statusCode
                                });
                            }
                        }
                    );
                }
            );
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        }
    );
}

/* ====================================
   GET TOKEN
   POST /token
   ==================================== */
async function getToken() {
    var body = JSON.stringify({
        userID: BAZIK_USER_ID,
        secretKey: BAZIK_SECRET
    });

    var options = {
        hostname: BAZIK_HOST,
        path: '/token',
        method: 'POST',
        headers: {
            'Content-Type':
                'application/json',
            'Content-Length':
                Buffer.byteLength(body)
        }
    };

    var result = await httpReq(
        options, body
    );

    if (!result.access_token) {
        throw new Error(
            "Token failed: " +
            JSON.stringify(result)
        );
    }

    console.log("Token OK ✅");
    return result.access_token;
}

/* ====================================
   CREATE MONCASH PAYMENT
   POST /moncash/token
   ==================================== */
async function createPayment(
    amount, orderId, email,
    firstName, lastName, userId
) {
    var token = await getToken();

    var body = JSON.stringify({
        gdes: amount,
        userID: BAZIK_USER_ID,
        successUrl: SUCCESS_URL,
        errorUrl: ERROR_URL,
        description:
            "Bizen HT - Membership Premium",
        referenceId: orderId,
        customerFirstName:
            firstName || "Client",
        customerLastName:
            lastName || "BHT",
        customerEmail: email || "",
        webhookUrl: WEBHOOK_URL,
        metadata: {
            userId: userId || "",
            email: email || "",
            site: "bizenht.com",
            product: "premium"
        }
    });

    var options = {
        hostname: BAZIK_HOST,
        path: '/moncash/token',
        method: 'POST',
        headers: {
            'Content-Type':
                'application/json',
            'Content-Length':
                Buffer.byteLength(body),
            'Authorization':
                'Bearer ' + token
        }
    };

    var result = await httpReq(
        options, body
    );

    console.log(
        "Create payment result:", result
    );

    return result;
}

/* ====================================
   VERIFY PAYMENT
   ==================================== */
async function verifyPayment(orderId) {
    var token = await getToken();

    var paths = [
        '/moncash/verify/' + orderId,
        '/payment/verify/' + orderId,
        '/payment/' + orderId
    ];

    for (var i = 0; i < paths.length; i++) {
        try {
            var options = {
                hostname: BAZIK_HOST,
                path: paths[i],
                method: 'GET',
                headers: {
                    'Authorization':
                        'Bearer ' + token
                }
            };
            var r = await httpReq(
                options, null
            );

            var ok =
                r.status === 'success' ||
                r.status === 'completed' ||
                r.paid === true;

            if (ok || r.status) {
                return {
                    verified: ok,
                    status: r.status ||
                        'unknown'
                };
            }
        } catch(e) {
            console.log(
                "Verify", paths[i],
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
   CORS
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
   HANDLER
   ==================================== */
exports.handler = async function(
    event, context
) {
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: CORS,
            body: ''
        };
    }

    try {
        var body = JSON.parse(
            event.body || '{}'
        );
        var action = body.action;

        console.log("=== ACTION:", action);

        /* TEST */
        if (action === 'test') {
            try {
                await getToken();
                return {
                    statusCode: 200,
                    headers: CORS,
                    body: JSON.stringify({
                        success: true,
                        message:
                            "Bazik.io OK! " +
                            "Peman pret."
                    })
                };
            } catch(e) {
                return {
                    statusCode: 200,
                    headers: CORS,
                    body: JSON.stringify({
                        success: false,
                        message: e.message
                    })
                };
            }
        }

        /* CREATE */
        if (action === 'create') {
            var amount = body.amount || 1000;
            var orderId = 'BHT-' +
                Date.now() + '-' +
                Math.random()
                    .toString(36)
                    .substr(2, 6)
                    .toUpperCase();

            var payment = await createPayment(
                amount,
                orderId,
                body.userEmail || "",
                body.firstName || "Client",
                body.lastName || "BHT",
                body.userId || ""
            );

            /* Find payment URL */
            var payUrl =
                payment.paymentUrl ||
                payment.payment_url ||
                payment.redirect_url ||
                payment.redirectUrl ||
                payment.url ||
                payment.link ||
                null;

            /* If MonCash token returned */
            if (!payUrl && payment.token) {
                payUrl =
                    'https://moncashbutton' +
                    '.digicelgroup.com/' +
                    'Moncash-middleware/' +
                    'Payment/Redirect?token=' +
                    payment.token;
            }

            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({
                    success: !!payUrl,
                    orderId: orderId,
                    paymentUrl: payUrl,
                    raw: payment
                })
            };
        }

        /* VERIFY */
        if (action === 'verify') {
            if (!body.orderId) {
                return {
                    statusCode: 400,
                    headers: CORS,
                    body: JSON.stringify({
                        success: false,
                        error: 'orderId requis'
                    })
                };
            }

            var result = await verifyPayment(
                body.orderId
            );

            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({
                    success: true,
                    verified: result.verified,
                    status: result.status
                })
            };
        }

        return {
            statusCode: 400,
            headers: CORS,
            body: JSON.stringify({
                error: 'Action invalide'
            })
        };

    } catch(error) {
        console.error("Error:", error);
        return {
            statusCode: 500,
            headers: CORS,
            body: JSON.stringify({
                error: error.message
            })
        };
    }
};