import axios from 'axios';
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
    console.log(contactsList, query)
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
    return axios.get(url, {
        responseType: 'arraybuffer'
    }).then(response => {
        return Buffer.from(response.data, 'binary').toString('base64');
    }).catch((error) => {
        console.error('Error getting image from url', error);
    });
}

export const toConsistentId = function(input) {
  const normalized = input.trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}