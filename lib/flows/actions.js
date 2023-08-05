exports.init = async function (homey) {
    const action_send_message = homey.flow.getActionCard('action_send_message');
    action_send_message.registerRunListener(async (args, state) => {
        await args.device.onCapability_SendMessage(args, false);
    })

    const action_send_message_document = homey.flow.getActionCard('action_send_message_document');
    action_send_message_document.registerRunListener(async (args, state) => {
        await args.device.onCapability_SendMessage(args, 'document');
    })

    const action_send_message_video = homey.flow.getActionCard('action_send_message_video');
    action_send_message_video.registerRunListener(async (args, state) => {
        await args.device.onCapability_SendMessage(args, 'video');
    })

    const action_send_message_audio = homey.flow.getActionCard('action_send_message_audio');
    action_send_message_audio.registerRunListener(async (args, state) => {
        await args.device.onCapability_SendMessage(args, 'audio');
    })

    const action_send_message_image = homey.flow.getActionCard('action_send_message_image');
    action_send_message_image.registerRunListener(async (args, state) => {
        await args.device.onCapability_SendMessage(args, 'image');
    })

    const action_send_message_image_token = homey.flow.getActionCard('action_send_message_image_token');
    action_send_message_image_token.registerRunListener(async (args, state) => {
        await args.device.onCapability_SendMessage(args, 'image');
    })
};
