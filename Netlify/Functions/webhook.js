/* ====================================
   BAZIK.IO - WEBHOOK + MONCASH (corrigé)
   ==================================== */

const https = require('https');

var BAZIK_USER_ID = process.env.BAZIK_USER_ID || "";
var BAZIK_SECRET  = process.env.BAZIK_SECRET || "";
var BAZIK_HOST    = "api.bazik.io";

var SITE_URL    = "https://bizenht.com";
var WEBHOOK_URL = SITE_URL + "/.netlify/functions/webhook";

/* ====================================
   HTTP REQUEST
   ==================================== */
function httpReq(options, body) {
    return new Promise(function (resolve, reject) {
        var req = https.request(options, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                console.log("HTTP", options.path, "->", res.statusCode);
                console.log("Body:", data.substring(0, 300));
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve({ raw: data, statusCode: res.statusCode }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, function () {
            req.destroy(new Error("Request timeout"));
        });
        if (body) req.write(body);
        req.end();
    });
}

/* ====================================
   GET TOKEN  (FIX: token || access_token)
   ==================================== */
async function getToken() {
    if (!BAZIK_USER_ID || !BAZIK_SECRET) {
        throw new Error("Missing env vars BAZIK_USER_ID / BAZIK_SECRET");
    }

    var body = JSON.stringify({
        userID: BAZIK_USER_ID,
        secretKey: BAZIK_SECRET
    });

    var options = {
        hostname: BAZIK_HOST,
        path: '/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        }
    };

    var result = await httpReq(options, body);

    /* FIX: Bazik renvoie "token" (pas "access_token") */
    var tok = result.token || result.access_token;
    if (!tok) {
        throw new Error("Token failed: " + JSON.stringify(result));
    }

    console.log("Token OK ✅");
    return tok;
}

/* ====================================
   CREATE MONCASH PAYMENT
   ==================================== */
async function createPayment(p) {
    var token = await getToken();

    var isReservation = p.purpose === "reservation";

    var description = isReservation
        ? "Bizen HT - Rezevasyon Elu"
        : "Bizen HT - Membership Premium";

    var successUrl =
        SITE_URL + "/?payment=success&ref=" + p.orderId +
        (isReservation ? "&resId=" + (p.reservationId || "") : "");

    var body = JSON.stringify({
        gdes: parseFloat(p.amount),
        userID: BAZIK_USER_ID,
        successUrl: successUrl,
        errorUrl: SITE_URL + "/?payment=error&ref=" + p.orderId,
        description: description,
        referenceId: p.orderId,
        customerFirstName: p.firstName || "Client",
        customerLastName: p.lastName || "BHT",
        customerEmail: p.email || "",
        webhookUrl: WEBHOOK_URL,
        metadata: {
            userId: p.userId || "",
            email: p.email || "",
            site: "bizenht.com",
            product: isReservation ? "reservation" : "premium",
            purpose: p.purpose || "premium",
            reservationId: p.reservationId || ""
        }
    });

    var options = {
        hostname: BAZIK_HOST,
        path: '/moncash/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Authorization': 'Bearer ' + token
        }
    };

    var result = await httpReq(options, body);
    console.log("Create payment result:", result);
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
                headers: { 'Authorization': 'Bearer ' + token }
            };
            var r = await httpReq(options, null);
            var ok = r.status === 'success' ||
                     r.status === 'completed' ||
                     r.paid === true;
            if (ok || r.status) {
                return { verified: ok, status: r.status || 'unknown' };
            }
        } catch (e) {
            console.log("Verify", paths[i], "failed:", e.message);
        }
    }
    return { verified: false, status: 'unknown' };
}

/* ====================================
   CORS
   ==================================== */
var CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

/* ====================================
   HANDLER
   ==================================== */
exports.handler = async function (event, context) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS, body: '' };
    }

    try {
        var body = JSON.parse(event.body || '{}');
        var action = body.action;

        /* === VRAIE NOTIFICATION BAZIK (pas d'action) ===
           Bazik appelle ce webhook après paiement.
           On journalise et on répond 200. */
        if (!action) {
            console.log("=== WEBHOOK BAZIK NOTIFICATION ===");
            console.log(JSON.stringify(body));
            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({ received: true })
            };
        }

        console.log("=== ACTION:", action);

        /* TEST */
        if (action === 'test') {
            try {
                await getToken();
                return {
                    statusCode: 200, headers: CORS,
                    body: JSON.stringify({ success: true, message: "Bazik.io OK! Peman pret." })
                };
            } catch (e) {
                return {
                    statusCode: 200, headers: CORS,
                    body: JSON.stringify({ success: false, message: e.message })
                };
            }
        }

        /* CREATE */
        if (action === 'create') {
            var orderId = 'BHT-' + Date.now() + '-' +
                Math.random().toString(36).substr(2, 6).toUpperCase();

            var payment = await createPayment({
                amount: body.amount || 1000,
                orderId: orderId,
                email: body.userEmail || "",
                firstName: body.firstName || "Client",
                lastName: body.lastName || "BHT",
                userId: body.userId || "",
                purpose: body.purpose || "premium",
                reservationId: body.reservationId || ""
            });

            var payUrl =
                payment.paymentUrl ||
                payment.payment_url ||
                payment.redirect_url ||
                payment.redirectUrl ||
                payment.url ||
                payment.link ||
                null;

            if (!payUrl && payment.token) {
                payUrl =
                    'https://moncashbutton.digicelgroup.com/' +
                    'Moncash-middleware/Payment/Redirect?token=' +
                    payment.token;
            }

            return {
                statusCode: 200, headers: CORS,
                body: JSON.stringify({
                    success: !!payUrl,
                    orderId: orderId,
                    referenceId: orderId,
                    paymentUrl: payUrl,
                    raw: payment
                })
            };
        }

        /* VERIFY */
        if (action === 'verify') {
            var oid = body.orderId || body.referenceId;
            if (!oid) {
                return {
                    statusCode: 400, headers: CORS,
                    body: JSON.stringify({ success: false, error: 'orderId requis' })
                };
            }
            var result = await verifyPayment(oid);
            return {
                statusCode: 200, headers: CORS,
                body: JSON.stringify({ success: true, verified: result.verified, status: result.status })
            };
        }

        return {
            statusCode: 400, headers: CORS,
            body: JSON.stringify({ error: 'Action invalide' })
        };

    } catch (error) {
        console.error("Error:", error);
        return {
            statusCode: 200, headers: CORS,
            body: JSON.stringify({ received: true, error: error.message })
        };
    }
};
