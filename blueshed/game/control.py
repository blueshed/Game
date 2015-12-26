

class Control(object):

    def __init__(self):
        self._clients = []

    def echo(context, message):
        return "You said: {}". format(message)
