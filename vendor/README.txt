Omnitone v1.3.0
Source of the unmodified browser bundle:
https://swansphere.github.io/assets/lib/omnitone.min.js
Upstream: https://github.com/GoogleChrome/omnitone
License: Apache License 2.0; see OMNITONE-LICENSE.
Copyright 2016 Google Inc. All Rights Reserved.

The bundle includes its FOA HRIR filters as base64 resources. Playback does not
fetch a remote decoder, impulse response, font, or other runtime dependency.

The audio engine expects ACN/SN3D (AmbiX) FOA in W,Y,Z,X file channel order.
Reference specifications:
https://github.com/google/spatial-media/blob/master/docs/spatial-audio-rfc.md
https://github.com/GoogleChrome/omnitone/blob/master/src/foa-rotator.js
