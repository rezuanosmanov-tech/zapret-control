// Пресеты доменов, сгруппированные по конкретным сервисам. Каждая категория —
// это набор сервисов, у каждого сервиса свой список доменов. В окне пользователь
// выбирает нужные сервисы галочками, а не всю категорию целиком.
//
// Домены строго не пересекаются между сервисами: если ресурс относится к двум
// (например, у сервиса и его CDN общий домен) — он указан только один раз, у
// основного владельца.
module.exports = {
  games: {
    label: 'Игры и лаунчеры',
    services: {
      steam:    { label: 'Steam', domains: [
        'steampowered.com','store.steampowered.com','api.steampowered.com','steamcommunity.com',
        'steamstatic.com','steamcontent.com','steamusercontent.com','steamcdn-a.akamaihd.net',
        'steamserver.net','steamgames.com','valvesoftware.com','cdn.cloudflare.steamstatic.com',
        'steamuserimages-a.akamaihd.net' ] },
      epic:     { label: 'Epic Games', domains: [
        'epicgames.com','store.epicgames.com','api.epicgames.com','epicgames.dev','unrealengine.com',
        'fortnite.com','easyanticheat.net' ] },
      ea:       { label: 'EA', domains: ['ea.com','origin.com','eaassets-a.akamaihd.net'] },
      ubisoft:  { label: 'Ubisoft', domains: ['ubisoft.com','ubisoftconnect.com','ubi.com'] },
      blizzard: { label: 'Battle.net', domains: ['battle.net','blizzard.com'] },
      riot:     { label: 'Riot Games', domains: ['riotgames.com','riotcdn.net'] },
      rockstar: { label: 'Rockstar', domains: ['rockstargames.com','take2games.com'] },
      gog:      { label: 'GOG', domains: ['gog.com','gog-statics.com'] },
      faceit:   { label: 'FACEIT', domains: ['faceit.com','faceit-cdn.net'] },
    },
  },
  messengers: {
    label: 'Мессенджеры',
    services: {
      discord:  { label: 'Discord', domains: [
        'discord.com','discordapp.com','discordapp.net','discord.gg','discord.media' ] },
      telegram: { label: 'Telegram', domains: [
        'telegram.org','telegram.me','t.me','telegra.ph','cdn-telegram.org' ] },
      whatsapp: { label: 'WhatsApp', domains: ['whatsapp.com','whatsapp.net','wa.me'] },
      signal:   { label: 'Signal', domains: ['signal.org','whispersystems.org'] },
      viber:    { label: 'Viber', domains: ['viber.com'] },
      skype:    { label: 'Skype', domains: ['skype.com'] },
      slack:    { label: 'Slack', domains: ['slack.com','slack-edge.com'] },
    },
  },
  music: {
    label: 'Музыка и видео',
    services: {
      spotify:    { label: 'Spotify', domains: [
        'spotify.com','scdn.co','spotifycdn.com','spoti.fi','audio-ak-spotify-com.akamaized.net' ] },
      soundcloud: { label: 'SoundCloud', domains: ['soundcloud.com','sndcdn.com'] },
      deezer:     { label: 'Deezer', domains: ['deezer.com','dzcdn.net'] },
      tidal:      { label: 'Tidal', domains: ['tidal.com'] },
      applemusic: { label: 'Apple Music', domains: ['music.apple.com'] },
      lastfm:     { label: 'Last.fm', domains: ['last.fm'] },
      bandcamp:   { label: 'Bandcamp', domains: ['bandcamp.com','bcbits.com'] },
      twitch:     { label: 'Twitch', domains: ['twitch.tv','jtvnw.net','ttvnw.net','live-video.net'] },
    },
  },
  social: {
    label: 'Соцсети',
    services: {
      x:         { label: 'X / Twitter', domains: ['x.com','twitter.com','twimg.com','t.co','twttr.com'] },
      instagram: { label: 'Instagram', domains: ['instagram.com','cdninstagram.com'] },
      facebook:  { label: 'Facebook', domains: ['facebook.com','fbcdn.net','fb.com'] },
      threads:   { label: 'Threads', domains: ['threads.net'] },
      reddit:    { label: 'Reddit', domains: ['reddit.com','redd.it','redditstatic.com','redditmedia.com'] },
      tumblr:    { label: 'Tumblr', domains: ['tumblr.com'] },
      pinterest: { label: 'Pinterest', domains: ['pinterest.com','pinimg.com'] },
      linkedin:  { label: 'LinkedIn', domains: ['linkedin.com','licdn.com'] },
      tiktok:    { label: 'TikTok', domains: ['tiktok.com','tiktokcdn.com','tiktokv.com','ibytedtos.com'] },
    },
  },
  stores: {
    label: 'Магазины приложений',
    services: {
      appstore:  { label: 'App Store', domains: ['apps.apple.com'] },
      itch:      { label: 'itch.io', domains: ['itch.io'] },
      aptoide:   { label: 'Aptoide', domains: ['aptoide.com'] },
      apkpure:   { label: 'APKPure', domains: ['apkpure.com'] },
      apkmirror: { label: 'APKMirror', domains: ['apkmirror.com'] },
      fdroid:    { label: 'F-Droid', domains: ['f-droid.org'] },
      xbox:      { label: 'Xbox', domains: ['xboxlive.com','xbox.com'] },
      playstation: { label: 'PlayStation', domains: ['playstation.com','playstation.net'] },
      nintendo:  { label: 'Nintendo', domains: ['nintendo.net','nintendo.com'] },
    },
  },
  ru: {
    label: 'Российские сервисы',
    services: {
      vk:        { label: 'VK', domains: ['vk.com','vk.ru','userapi.com','vkuservideo.net','vk-cdn.net','mycdn.me'] },
      okru:      { label: 'Одноклассники', domains: ['ok.ru','odnoklassniki.ru'] },
      yandex:    { label: 'Яндекс', domains: [
        'yandex.ru','ya.ru','yandex.net','yastatic.net','yandex.com','yandexcloud.net' ] },
      yamusic:   { label: 'Яндекс Музыка', domains: ['music.yandex.ru'] },
      kinopoisk: { label: 'Кинопоиск', domains: ['kinopoisk.ru','kp.ru'] },
      mailru:    { label: 'Mail.ru', domains: ['mail.ru','imgsmail.ru'] },
      rutube:    { label: 'RuTube', domains: ['rutube.ru'] },
      gosuslugi: { label: 'Госуслуги', domains: ['gosuslugi.ru'] },
      sberbank:  { label: 'Сбер', domains: ['sberbank.ru','sber.ru','online.sberbank.ru'] },
      avito:     { label: 'Авито', domains: ['avito.ru','avito.st'] },
      wildberries: { label: 'Wildberries', domains: ['wildberries.ru','wbbasket.ru','wb.ru'] },
      ozon:      { label: 'Ozon', domains: ['ozon.ru','ozone.ru','ozon.app'] },
    },
  },
};
