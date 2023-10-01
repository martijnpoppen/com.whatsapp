const mainDevice = require('../main-device');

module.exports = class Whatsapp extends mainDevice {
    async isTyping() {
        return true;
    }
};
