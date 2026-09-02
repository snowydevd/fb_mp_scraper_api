# Correrlo en horario, sin la laptop abierta

## Por qué NO en Cloudflare Workers (ni en la nube, en general)

**Cloudflare Workers no puede correr esto.** Corre en aislados de V8: no hay
sistema de archivos, no hay binarios propios, y Chromium no entra. Habría que
reescribir el extractor contra Browser Rendering (`@cloudflare/puppeteer`, plan
pago), y aun así el modelo del pipeline pelea con la plataforma: delays de 8-20s
por navegación, presupuesto de 100 avisos, corridas de ~40s. Los Workers están
hechos para lo contrario.

Pero hay una razón más de fondo, que aplica a **cualquier** nube:

> Desde una IP residencial de Uruguay el Marketplace anónimo devuelve resultados
> normalmente. Desde IPs de datacenter Facebook suele redirigir al login.

Cloudflare, GitHub Actions, un VPS: todos salen por IP de datacenter. Correr
desde tu conexión de casa no es una limitación del proyecto, es lo que lo hace
funcionar. Si igual querés sacarlo de la laptop, lo que corresponde es otra
máquina **en tu misma conexión** —una Raspberry Pi, una PC vieja— no la nube.

## systemd (esta máquina, o cualquier Linux de tu red)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/fbmp-worker.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fbmp-worker.timer

# Que corra aunque no tengas sesión abierta (si no, se apaga al desloguearte)
sudo loginctl enable-linger $USER
```

Verificar:

```bash
systemctl --user list-timers fbmp-worker.timer   # cuándo dispara la próxima
systemctl --user start fbmp-worker.service       # forzar una corrida ahora
journalctl --user -u fbmp-worker -f              # ver los logs en vivo
journalctl --user -u fbmp-worker --since today   # lo de hoy
```

El horario está en `OnCalendar` del `.timer` (por defecto 09, 15 y 21) con hasta
45 minutos de retraso aleatorio encima. Para cambiarlo, editá el archivo y
`systemctl --user daemon-reload`.

`Persistent=true` recupera un disparo perdido si la máquina estuvo apagada —
uno solo, no la cola acumulada.

## La otra opción: el scheduler propio

`npm run worker:schedule` hace lo mismo dentro de Node: intervalo con jitter,
ventana horaria de Montevideo, sin solapar corridas, presupuesto reseteado por
corrida y Chromium cerrado entre corridas.

Es útil para probar. Para dejarlo andando conviene el timer: si el proceso se
cuelga o se muere, systemd lo limpia y el próximo disparo arranca igual, mientras
que un proceso de larga vida se cae en silencio y nadie se entera.
