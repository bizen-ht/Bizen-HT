/* ====================================
   BAZIK.IO - MONCASH PRODUCTION
   ==================================== */

const https = require('https');
const crypto = require('crypto');

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
   FIREBASE ADMIN (init paresseux)
   Sert UNIQUEMENT au webhook pour activer
   un compte côté serveur (écriture Firestore).
   ==================================== */
var _adminReady = false;
function getAdminDb() {
    var admin = require('firebase-admin');
    if (!_adminReady) {
        var raw = process.env.FIREBASE_SERVICE_ACCOUNT || "";
        if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT manquant (clé de service)");
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(raw))
            });
        }
        _adminReady = true;
    }
    return admin.firestore();
}

/* ====================================
   VÉRIFICATION SIGNATURE BAZIK (HMAC-SHA256)
   signedPayload = `${timestamp}.${eventId}.${rawBody}`
   header X-Bazik-Signature = `v1=${hmac}`
   ==================================== */
function verifyBazikSignature(headers, rawBody) {
    var secret = process.env.BAZIK_WEBHOOK_SECRET || "";
    if (!secret) return false;
    var sig = headers['x-bazik-signature'] || headers['X-Bazik-Signature'] || "";
    var ts = headers['x-bazik-timestamp'] || headers['X-Bazik-Timestamp'] || "";
    var eid = headers['x-bazik-event-id'] || headers['X-Bazik-Event-Id'] || "";
    var signedPayload = ts + "." + eid + "." + (rawBody || "");
    var expected = "v1=" + crypto.createHmac('sha256', secret)
        .update(signedPayload).digest('hex');
    try {
        var a = Buffer.from(sig);
        var b = Buffer.from(expected);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) { return false; }
}

/* ====================================
   TRAITE UNE NOTIFICATION "payment.succeeded"
   - confirme le paiement (par referenceId)
   - active Premium (si purpose != reservation)
   - crédite l'affilié (idempotent via promoCredited)
   ==================================== */
async function processPaidWebhook(body) {
    var admin = require('firebase-admin');
    var db = getAdminDb();
    var refId = body.referenceId || body.orderId;
    if (!refId) { console.log("[WEBHOOK] Pas de referenceId"); return; }

    var snap = await db.collection("payments")
        .where("referenceId", "==", refId).limit(1).get();
    if (snap.empty) { console.log("[WEBHOOK] Aucun paiement:", refId); return; }

    var docRef = snap.docs[0].ref;
    var pay = snap.docs[0].data();

    if (pay.status === "confirmed") { console.log("[WEBHOOK] Déjà confirmé:", refId); return; }

    await docRef.update({
        status: "confirmed",
        transactionId: body.transactionId || null,
        webhookConfirmedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    /* Premium uniquement (les réservations n'activent pas Premium) */
    if (pay.purpose !== "reservation" && pay.userId) {
        await db.collection("users").doc(pay.userId).update({
            isPremium: true,
            premiumActivatedAt: admin.firestore.FieldValue.serverTimestamp()
        }).catch(function(e) { console.log("[WEBHOOK] premium:", e.message); });
    }

    /* Commission affilié (si code valide + actif + pas déjà crédité) */
    if (pay.promoCode && !pay.promoCredited && pay.purpose !== "reservation") {
        var code = String(pay.promoCode).trim().toUpperCase();
        var codeSnap = await db.collection("promoCodes").doc(code).get();
        if (codeSnap.exists) {
            var c = codeSnap.data();
            if (c.active !== false) {
                var commission = Math.round((pay.amount || 1000) * ((c.commissionPct || 10) / 100));
                await docRef.update({ promoCredited: true, promoCommission: commission, promoOwnerEmail: c.ownerEmail || "" });
                await db.collection("promoCodes").doc(code).update({
                    totalUses: admin.firestore.FieldValue.increment(1),
                    totalEarned: admin.firestore.FieldValue.increment(commission)
                });
                await db.collection("affiliateTransactions").add({
                    code: code, ownerEmail: c.ownerEmail || "",
                    paymentId: docRef.id, buyerEmail: pay.email || "",
                    amount: pay.amount || 1000, commission: commission,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log("[WEBHOOK] Commission", commission, "->", code);
            }
        }
    }
    console.log("[WEBHOOK] OK — Premium activé:", refId);
}

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

    /* ===== NOTIFICATION WEBHOOK BAZIK (additif, ne touche pas le reste) ===== */
    var hdrs = event.headers || {};
    if (hdrs['x-bazik-signature'] || hdrs['X-Bazik-Signature']) {
        var rawBody = event.isBase64Encoded
            ? Buffer.from(event.body || "", 'base64').toString('utf8')
            : (event.body || "");
        if (!verifyBazikSignature(hdrs, rawBody)) {
            console.warn("[WEBHOOK] Signature invalide");
            return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "invalid signature" }) };
        }
        try {
            var wbody = JSON.parse(rawBody || "{}");
            console.log("[WEBHOOK] type:", wbody.type, "status:", wbody.status, "ref:", wbody.referenceId);
            if (wbody.type === "payment.succeeded" || wbody.status === "successful") {
                await processPaidWebhook(wbody);
            }
            return { statusCode: 200, headers: CORS, body: JSON.stringify({ received: true }) };
        } catch (e) {
            console.error("[WEBHOOK] Erreur:", e.message);
            /* 500 => Bazik réessaiera (l'idempotence évite le double-traitement) */
            return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
        }
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