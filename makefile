build:
	- rm consts.js
	echo "export const debug = false;\nexport const ws_url = 'ws://petermac.local:8080/websocket';\n" > consts.js
	- rm -rf dist
	mkdir dist
	jspm bundle-sfx appl/main dist/appl.js
	./node_modules/.bin/uglifyjs dist/appl.js -o dist/appl.min.js
	./node_modules/.bin/html-dist index.html --remove-all --minify --insert appl.min.js -o dist/index.html
	- rm consts.js
	echo "export const debug = true;\nexport const ws_url = 'ws://petermac.local:8080/websocket';\n" > consts.js
