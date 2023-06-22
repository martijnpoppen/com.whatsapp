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

module.exports = {
    sleep,
    validateMobile,
    validateUrl
};
