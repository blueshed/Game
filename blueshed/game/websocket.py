import tornado.websocket
import time
import urllib
import logging
from json import loads, dumps
from tornado.log import access_log


class WebSocketHandler(tornado.websocket.WebSocketHandler):

    @property
    def control(self):
        return self.application.settings["control"]

    def check_origin(self, origin):
        parsed_origin = urllib.parse.urlparse(origin)
        logging.info("websocket %s", parsed_origin)
        return parsed_origin.netloc in ["localhost:8080"]

    def open(self):
        self._game = None
        self.set_nodelay(True)
        self.control._clients.append(self)

    def handle_rpc(self, request_id, method, args):
        result = None
        context = None
        if method[0] == "_":
            raise Exception("Access denied.")
        if method == "echo":
            result = dumps({
                "result": "You said: " + args.get("message"),
                "response_id": request_id
            })
        elif hasattr(self.control, method):
            context = self
            result = dumps({
                "result": getattr(self.control, method)(context, **args),
                "response_id": request_id
            })
        else:
            raise Exception("no such method: {}".format(method))
        return context, result

    def on_message(self, message):
        start = time.time()
        logging.debug(message)
        request_id = method = None
        try:
            msg = loads(message)
            method = msg["method"]
            args = msg["args"]
            request_id = msg["request_id"]
            context, result = self.handle_rpc(request_id, method, args)
            if result:
                logging.debug(result)
                self.write_message(result)
            if context:
                context.flush()
        except Exception as ex:
            logging.exception(ex)
            error = str(ex)
            self.log_action(access_log.error, start,
                            method, self.current_user, error)
            self.write_message(dumps({
                "error": error,
                "response_id": request_id
            }))

    def broadcast(self, message):
        logging.info("broadcast: %s", message)
        self.write_message(message)

    def on_close(self):
        self.control._clients.remove(self)

    def force_close(self, code=None, reason=None):
        self.control._clients.remove(self)
        self.close(code, reason)

    def log_action(self, logger, start, action, user, message=''):
        request_time = (time.time() - start) * 1000
        logger("%s - %s - %s - %sms" %
               (action, self.current_user, message, request_time))
