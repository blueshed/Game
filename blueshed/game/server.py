import tornado.ioloop
import tornado.web
import logging
import os
from dotenv import load_dotenv
from tornado.options import define, options, parse_command_line
from blueshed.game.websocket import WebSocketHandler
from blueshed.game.control import Control

define("debug", False, bool, help="run in debug mode")
define("port", 8080, int, help="port to listen on")
define("db_url",
       default="sqlite:///",
       help="sqlalchemy connection url")


def main():
    options.log_to_stderr = False
    parse_command_line()

    if os.path.isfile('.env'):
        load_dotenv('.env')

    port = int(os.environ.get("PORT", options.port))

    handlers = [
        (r"/websocket", WebSocketHandler),
        (r"/(.*)", tornado.web.StaticFileHandler,
            {"path": "." if options.debug else 'dist',
             "default_filename": "index.html"}),
    ]
    settings = dict(
        cookie_name="game-cookie",
        cookie_secret="-game-secret-here-",
        control=Control(),
        debug=options.debug)

    app = tornado.web.Application(handlers, **settings)
    app.listen(port)
    logging.info("listening on port {}".format(port))
    if options.debug:
        logging.info("running in debug mode")
    tornado.ioloop.IOLoop.current().start()


if __name__ == "__main__":
    import logging.config
    main()
