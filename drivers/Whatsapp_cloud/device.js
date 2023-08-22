const mainDevice = require('../main-device');

module.exports = class WhatsappCloud extends mainDevice {
    async isTyping() {
        return true;
    }
};
