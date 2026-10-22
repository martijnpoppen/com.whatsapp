import crypto from 'crypto';

export const sleep = async function (ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

export const validateUrl = function(url) {
    const urlRegex = /^https?:\/\/(?:.*\/)?[^\/.]+$/g;
    if(urlRegex.test(url)){
        return true;
    } else {
        return false;
    }   
}

export const groupAutoComplete = function (query, args) {
    const device = args.device;
    const contactsList = device && device.getStoreValue('contactList') || [];
    return contactsList.filter((result) => {
        return result.name && result.name.toLowerCase().includes(query.toLowerCase());
     });
};

export const GetGUID = function() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0,
            v = c == 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export const getUrlExtension = function( url ) {
    return url.split(/[#?]/)[0].split('.').pop().trim();
}

export const getBase64Image = async function (url) {
  try {
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
  } catch (error) {
    console.error('Error getting image from url', error);
  }
};


export const toConsistentId = function(input) {
  const normalized = input.trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
export const parseGroupInvite = function (inviteLink) {
    let inviteCode = inviteLink.replace(/\s+/g, '');
    inviteCode = inviteCode.split('/').pop();
    inviteCode = inviteCode.includes('?') ? inviteCode.split('?')[0] : inviteCode;

    return inviteCode;
}

// Magic bytes for the formats WhatsApp accepts as an image. Content-Type alone is
// not enough: Homey's image endpoint can answer 200 with an error body, and some
// sources send image/* headers on something that is not an image.
const IMAGE_SIGNATURES = [
    { name: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
    { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
    { name: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
    { name: 'bmp', bytes: [0x42, 0x4d] },
    { name: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WEBP
    { name: 'heic', bytes: [0x00, 0x00, 0x00], offset: 4, ascii: 'ftyp' }
];

const matchesSignature = (head) =>
    IMAGE_SIGNATURES.find((sig) => {
        if (sig.ascii) {
            return head.slice(sig.offset, sig.offset + sig.ascii.length).toString('latin1') === sig.ascii;
        }
        return sig.bytes.every((b, i) => head[i] === b);
    });

// Check a media URL actually serves an image before handing it to Baileys.
//
// Without this the failure is completely silent: if the URL answers with an error
// page, an empty body or anything else that is not an image, Baileys uploads it
// regardless and WhatsApp renders a broken image, with nothing in the log to say
// why. The same bytes also reach the widget as `data:image/jpeg;base64,<garbage>`,
// so one bad URL breaks both places — which is how it was reported.
//
// Only the first 32 bytes are read and the body is then cancelled, so this costs a
// request header round trip rather than a second download of the image.
export const probeImageUrl = async function (url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        // No Accept header: a strict server could answer 406 and we would call a
        // working image broken.
        const res = await fetch(url, { signal: controller.signal });
        const contentType = res.headers.get('content-type') || '';
        const contentLength = res.headers.get('content-length');

        if (!res.ok) {
            return { ok: false, reason: `HTTP ${res.status} ${res.statusText}`, contentType, contentLength };
        }

        const reader = res.body && res.body.getReader();
        if (!reader) {
            return { ok: false, reason: 'no response body', contentType, contentLength };
        }

        const { value } = await reader.read();
        reader.cancel().catch(() => {});

        const head = Buffer.from(value ? value.slice(0, 32) : []);
        if (!head.length) {
            return { ok: false, reason: 'empty body', contentType, contentLength };
        }

        const signature = matchesSignature(head);
        if (!signature) {
            return {
                ok: false,
                reason: `not an image (first bytes ${head.slice(0, 8).toString('hex')})`,
                contentType,
                contentLength
            };
        }

        return { ok: true, format: signature.name, contentType, contentLength };
    } catch (error) {
        return { ok: false, reason: error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error.message };
    } finally {
        clearTimeout(timer);
    }
};

const IMAGE_MIME = {
    jpeg: { type: 'image/jpeg', ext: 'jpg' },
    png: { type: 'image/png', ext: 'png' },
    gif: { type: 'image/gif', ext: 'gif' },
    bmp: { type: 'image/bmp', ext: 'bmp' },
    webp: { type: 'image/webp', ext: 'webp' },
    heic: { type: 'image/heic', ext: 'heic' }
};

// Identify an image from its first bytes. The widget used to hardcode
// `data:image/jpeg` for everything, which is wrong for the PNG charts people
// send — browsers sniff and cope, but the stored file should carry the truth.
export const imageTypeFromBuffer = function (buffer) {
    if (!buffer || !buffer.length) return null;
    const sig = matchesSignature(buffer.slice(0, 32));
    return sig ? IMAGE_MIME[sig.name] || null : null;
};

export const sha256 = function (input) {
    return crypto.createHash('sha256').update(input).digest('hex');
};

// Anything written to /userdata is served over HTTP at
// https://<homey>/app/<app.id>/userdata/..., so a filename there is the only
// thing standing between a file and anyone who can reach the Homey. Homey's own
// docs are explicit about it: the name has to be random, not derived from the
// contents or from anything a third party could know.
export const randomId = function (bytes = 16) {
    return crypto.randomBytes(bytes).toString('hex');
};

// A client id is `<homeyCloudId>_<uuid>` and it is also the directory name under
// /userdata/auth, where creds.json — the linked-device credential — lives. Since
// /userdata is web-served and the filenames inside that folder are fixed, the id
// IS the secret. It used to be printed on nearly every log line, which put it in
// every diagnostics report a user sends in.
//
// So logs get a stable 8-hex tag instead: enough to tell two devices apart in one
// report, useless to anyone trying to reach the folder. To go from a tag back to
// a device: crypto.createHash('sha256').update(clientId).digest('hex').slice(0, 8)
export const clientTag = function (clientID) {
    if (!clientID) return 'none';
    return sha256(String(clientID)).slice(0, 8);
};

// Fetch an image as a Buffer. Replaces the base64-returning helper on the
// widget path: the bytes go to disk, and base64 is only produced for the live
// payload, so we no longer hold a string 1.33x the size of the image for
// anything that gets persisted.
export const fetchImageBuffer = async function (url, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return Buffer.from(await res.arrayBuffer());
    } catch (error) {
        console.error('[fetchImageBuffer] failed', url, error.message);
        return null;
    } finally {
        clearTimeout(timer);
    }
};
