<h1 align="center">Whatsapp for Homey</h1>

<p align="center">
  <a href="https://homey.app/nl-nl/apps/author/5e2daad2e3e0da0ca754b6a8/page/0/">
    <img src="https://www.mobiledekho.com/wp-content/uploads/2017/11/952x501-5.jpg" />
  </a>
</p>

<p align="center">Full whatsapp integration for Homey.</p>


<p align="center">Created by <a href="https://homey.app/nl-nl/apps/author/5e2daad2e3e0da0ca754b6a8/page/0/">Martijn Poppen</a></p> 
  

## General
---
Whatsapp for Homey is a complete intergration without the intervention of a bot. With this Homey app, you send messages, videos, photos, documents and audio messages to a mobile number or Whatsapp group from your own name.


## Prerequisite
---
- Creat a [Whatsapp apiKey](https://textmebot.com/#lepopup-NewApiKey) 
- When you have the apiKey from [ThextMeBot](https://textmebot.com/#lepopup-NewApiKey), go directley into Homey

## Usage
---
- Install this app on your Homey
- Go to add devices
- Provide your mobile number and apiKey (from TextMeBot). Click Next
- Scan the QR code whith the Whatsapp from your mobile number


## Current features: 🔧
---
-  Send from your personal number to Groups or just one receiver
-  Send Text Messages
-  Send Images
-  Send Documents
-  Send Video
-  Of course, you can put all available Homey tags in the text field and send snapshots/artworks via the dedicated image tag card.
  
## Contributors: 🔧
---
- <a href="https://github.com/LRvdLinden">LRvdLinden</a>
- <a href="https://textmebot.com">TextMeBot</a> (creator of the apiKey)


## Result
---

![wa png](https://github.com/martijnpoppen/com.whatsapp/assets/77990847/6ce276c0-5923-422c-9a50-4327176a3a23)






## ⚠️Warning⚠️ (please read and remember)
---
WhatsApp will block your number if you send messages to people who is not expecting to receive a message from you.
Please use this app with caution and responsibility.

Some recommendations to avoid getting your phone number blocked by WhatsApp
1) Implement a delay between messages (min. 5 seconds). The more the better.
2) Do not send messages to people that you do not know.
3) It is recommended to have the recipient of the message in your phone contact list
4) Use a dedicated phone number for the API. If WhatsApp block your number, you do not loose your personal chats, images, contacts, documents, etc.
5) A loop in your code will send 100s of message and whatsapp will block your number. Be careful!


## 🚨Disclaimer🚨 (please read and remember):
---
a) This API is inended for Personal Usage only. If you decide to use it for Business, it is at your own risk.
b) Ensure to have a robust contingenct plan. Like Twilio. To be used in case of API downtime.
c) You are the only one responsible for the messages and the content that you sent. Rember that messages will be sent from your phone number.
d) TextMeBot is not responsible for any ban or block performed by WhatsApp on your number. And I cant do anything to unblock it


