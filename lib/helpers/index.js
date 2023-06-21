sleep = async function (ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

validateMobile = async function(mobilenumber) {   
    var regmm='^([0|+[0-9]{1,5})?([7-9][0-9]{9})$';
    var regmob = new RegExp(regmm);
    if(regmob.test(mobilenumber)){
        return true;
    } else {
        return false;
    }    
}


module.exports = {
    sleep
};
