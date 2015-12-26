import os
import json


class Control(object):

    def __init__(self):
        self._clients = []
        self._state = {}
        self._load_state()

    def _load_state(self):
        if os.path.isfile("games.json"):
            with open("games.json", "r") as file:
                self._state = json.load(file)

    def _save_state(self):
        with open("games.json", "w") as file:
            json.dump(self._state, file, indent=4)

    def echo(context, message):
        return "You said: {}". format(message)

    def get_games(self, context):
        return list(self._state.keys())

    def create_game(self, context, name):
        self._state[name] = {
            'name': name,
            'users': [],
            'transcript': []
        }
        broadcast = json.dumps({
            'signal': "created_game",
            'message': name
        })
        self._broadcast_to_game_(None, broadcast)
        return True

    def enter_game(self, context, name, username):
        game = self._state[name]
        game.setdefault("users", []).append(username)
        context._game = game
        context._username = username
        broadcast = json.dumps({
            'signal': "entered_game",
            'message': context._username
        })
        self._broadcast_to_game_(game, broadcast)
        return game

    def leave_game(self, context):
        game = context._game
        game.setdefault("users", []).remove(context._username)
        broadcast = json.dumps({
            'signal': "left_game",
            'message': context._username
        })
        context._game = None
        context._username = None
        self._broadcast_to_game_(game, broadcast)
        return True

    def say(self, context, message):
        game = context._game
        broadcast = json.dumps({
            'signal': "said",
            'message': {
                'username': context._username,
                'said': message
            }
        })
        self._broadcast_to_game_(game, broadcast)
        return True

    def _broadcast_to_game_(self, game, broadcast):
        if game:
            game.setdefault("transcript", []).append(broadcast)
        self._save_state()
        for client in self._clients:
            if game is None or client._game == game:
                client.broadcast(broadcast)
