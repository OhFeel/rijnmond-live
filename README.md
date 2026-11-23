# Rijnmond Live

Live kaart van metro, tram en bus in de regio Rotterdam: posities, vertragingen, vertrektijden per halte,
stiptheid per vervoerder en een timelapse. Onofficieel project, niet van RET of andere vervoerders.

## Lokaal draaien

Node 24 of nieuwer:

```
npm install
npm test
npm start
```

Open http://localhost:3000. De eerste start per dag downloadt de dienstregeling (±280 MB) en verwerkt die:
reken op een paar minuten. Daarna komt alles uit de cache in `data/`.

## Online zetten (VPS met Docker)

Een kleine VPS is genoeg: 1 vCPU, **1 GB RAM** (het verwerken van de dienstregeling piekte in een test op
±500 MB) en 5 GB schijf. Op de server:

```
docker build -t rijnmond-live .
docker run -d --name rijnmond-live --restart unless-stopped -p 127.0.0.1:3000:3000 -v rijnmond-data:/data rijnmond-live
```

Zet er een reverse proxy met HTTPS voor. Met [Caddy](https://caddyserver.com) is dat één bestand
(`/etc/caddy/Caddyfile`), Caddy regelt het certificaat zelf:

```
jouwdomein.nl {
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1
  }
}
```

`flush_interval -1` is nodig voor de live-updates (Server-Sent Events). Gezondheid controleren:
`curl https://jouwdomein.nl/healthz`.

Fly.io, Railway en vergelijkbare hosts werken ook: gebruik de Dockerfile, koppel een volume op `/data`
en geef de machine 1 GB geheugen.

## Instellingen (omgevingsvariabelen)

| Variabele | Standaard | Wat |
| --- | --- | --- |
| `PORT` | `3000` | Poort van de webserver |
| `DATA_DIR` | `./data` | Downloads, caches en opnames (als volume koppelen) |
| `MAX_CLIENTS` | `500` | Maximaal aantal gelijktijdige live-verbindingen |
| `TZ` | – | Moet `Europe/Amsterdam` zijn (de Dockerfile zet dit) |

## Wat de server doet

- Haalt elke 10 s de voertuigposities en elke 2 min de ritupdates op bij OVapi (alleen bij wijzigingen).
  Bezoekers praten alleen met deze server, nooit met OVapi zelf.
- Luistert met één ZeroMQ-verbinding naar de KV6-livestream van [GOVI](https://govi.nu/realtime.html)
  (voorheen NDOV Loket, `tcp://pubsub.besteffort.ndovloket.nl:7658`, uitgaand TCP-verkeer moet dus mogen).
  Die meldt posities, aankomst en vertrek per halte binnen ~1 s; de server stuurt elke seconde de wijzigingen
  door. Best-effort, fair use: maximaal één verbinding. Valt de stream weg, dan werkt alles door op OVapi.
  Voor intensief publiek gebruik: meld je aan bij GOVI (govi.nu/aanmelden).
- Eén keer per dag: dienstregeling downloaden. Nieuwe buslijnen worden via de publieke OSRM-server op de weg
  gelegd (max. 1 verzoek per seconde, daarna gecachet). Metro- en tramsporen komen één keer per week uit
  OpenStreetMap (Overpass API).
- Neemt elke minuut alle posities op voor timelapse en stiptheid. Opnames ouder dan 7 dagen worden opgeruimd
  (±60 MB per dag).

## Bronnen en licenties

- Dienstregeling en realtime: [OVapi](https://ovapi.nl) (open data van de vervoerders via NDOV).
- Livestream KV6: [GOVI / Stichting OpenGeo](https://govi.nu) (CC0).
- Kaarttegels: [OpenFreeMap](https://openfreemap.org), © [OpenStreetMap](https://www.openstreetmap.org/copyright)-bijdragers (ODbL).
- Metro- en tramsporen: © OpenStreetMap-bijdragers (ODbL).
- Routes over de weg: [OSRM](https://project-osrm.org) demo-server. Bij veel verkeer of commercieel gebruik: zelf
  een OSRM-server draaien.
- Materieeltypes (metro/tram): Wikipedia-lijsten van het RET-materieel.

De bronvermelding staat ook onderin het paneel van de app; laat die staan.
