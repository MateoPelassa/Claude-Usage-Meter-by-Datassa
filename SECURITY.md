# Seguridad / Security

**Español** · [English](#english)

## Cómo avisar una falla

Si encontrás una falla de seguridad en el widget, avisame de forma privada, **sin abrir un issue público**:

1. Entrá a la pestaña [Security](https://github.com/MateoPelassa/Claude-Usage-Meter-by-Datassa/security) del repositorio.
2. Tocá **Report a vulnerability**.

Contame qué encontraste, cómo reproducirlo y qué efecto tiene. Con un ejemplo mínimo alcanza. Es un proyecto personal y gratuito: respondo cuando puedo, sin plazos garantizados, pero lo tomo en serio.

## Qué se considera una falla

Algo que cruce un límite de confianza, por ejemplo:

- que una página o un archivo de otra persona logre ejecutar un programa o leer tu sesión de Claude a través del widget;
- que el token o la sesión de claude.ai salgan a un destino que no sea `api.anthropic.com` o `claude.ai`;
- que el apagado automático o el reintento se activen sin que lo hayas pedido.

No cuenta como falla algo que requiere que ya tengas control de tu propia cuenta de Windows (por ejemplo, editar tu propio `config.json`), ni el uso de direcciones no documentadas de Claude, que el README ya explica.

## Qué se revisó

Una revisión de seguridad **parcial**, solo leyendo el código (sin ejecutarlo), más una revisión manual del reintento. No es una auditoría formal ni garantiza que no haya fallas. Los arreglos están en el historial de commits.

## Versiones

Solo se mantiene la última versión de la rama `main`.

---

## English

### How to report a vulnerability

If you find a security issue in the widget, please report it **privately and do not open a public issue**:

1. Open the repository's [Security](https://github.com/MateoPelassa/Claude-Usage-Meter-by-Datassa/security) tab.
2. Click **Report a vulnerability**.

Tell me what you found, how to reproduce it and what the effect is. A minimal example is enough. This is a free personal project: I reply when I can, with no guaranteed timeline, but I take reports seriously.

### What counts as a vulnerability

Something that crosses a trust boundary, for example:

- a web page or someone else's file getting a program run or your Claude session read through the widget;
- the token or claude.ai session going anywhere other than `api.anthropic.com` or `claude.ai`;
- the automatic shutdown or retry turning on without you asking.

Not a vulnerability: anything that already requires control of your own Windows account (for example, editing your own `config.json`), or the use of undocumented Claude endpoints, which the README already explains.

### What was reviewed

A **partial** security review that only read the code (without running it), plus a manual review of the retry feature. It is not a formal audit and does not guarantee the absence of bugs. Fixes are in the commit history.

### Supported versions

Only the latest version on the `main` branch is maintained.
