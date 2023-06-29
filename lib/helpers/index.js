sleep = async function (ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

validateMobile = function(mobilenumber) {  
    const mobileRegex = /^(((\+[0-9]{2}))\)? ?){1}?(|\([0-9]*?\) ?)(800|900|906|909|6){1}.*$/g;

    if(mobileRegex.test(mobilenumber)){
        return true;
    } else {
        return false;
    }    
}


validateUrl = function(url) {
    const urlRegex = /^https?:\/\/(?:.*\/)?[^\/.]+$/g;
    if(urlRegex.test(url)){
        return true;
    } else {
        return false;
    }   
}


recipientAutoComplete = function (device, query) {
    let keys = device.getStore();

    keys = Object.entries(keys).map((e) => { 
        if(!e[0].startsWith('+')) {
            return { name: `https://chat.whatsapp.com/${e[0]}`, description: `https://chat.whatsapp.com/${e[0]}`};
        }
        return { name: e[0], description: e[0]};
    });

    return keys.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
};

module.exports = {
    sleep,
    validateMobile,
    validateUrl,
    recipientAutoComplete
};
