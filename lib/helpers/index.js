sleep = async function (ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

recipientAutoComplete = function (query, args) {
    const device = args.device;
    const contactsList = device && device.contactsList;

    return contactsList.filter((result) => {
        return result.name && result.name.toLowerCase().includes(query.toLowerCase());
     });
};

GetGUID = function() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0,
            v = c == 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

module.exports = {
    sleep,
    recipientAutoComplete,
    GetGUID
};
