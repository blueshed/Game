import './main.css!';
import tmpl from './main.html!text';
import WS from './ws';
import Vue from 'vue';
import {debug, ws_url} from 'consts';

Vue.config.debug=debug;

var appl = window.appl =  new Vue({
	el: '.main',
	template: tmpl,
    data(){
    	return {
			loading: true,
			connected: false,
			error: null,
			message: '',
			games: [],
			game: null,
			username: null,
			new_game_name: null,
			say_what: null,
		};
    },
	methods:{
		connect(){
			if(this.connected === false){
				this.$ws = new WS(this, ws_url);
			}
		},
		create_game(){
			if(this.new_game_name){
				this.$ws.rpc("create_game",{name:this.new_game_name}).then((result)=>{
					this.new_game_name = null;
				});
			}
		},
		enter_game(name){
			return this.$ws.rpc("enter_game",{name:name,username:this.username}).then((result)=>{
				this.game = result;
			});
		},
		leave_game(){
			this.$ws.rpc("leave_game",{}).then((result)=>{
				this.game = null;
			});
		},
		say(){
			this.$ws.rpc("say",{message:this.say_what}).then((result)=>{
				this.say_what = null;
			});
		},
		load_state(){
			if (window.localStorage) {
				var state = localStorage.getItem("state");
				if(state){
					state = JSON.parse(state);
				}
				this.username = state ? state.username : null;
				if(state && state.game_name){
					return this.enter_game(state.game_name);
				}
			}
			else {
				this.error = "No local storeage!"
			}

		},
		save_state(){
			if (window.localStorage) {
				localStorage.setItem("state",JSON.stringify({
					username: this.username,
					game_name: this.game ? this.game.name : null
				}));
			}
			else {
				this.error = "No local storeage!"
			}
		},
		rotation(index){
			var deg = (360 / this.game.users.length) * index;
			return "rotate(" + deg + "deg)";
		}
	},
	events:{
		created_game(message){
			this.games.push(message);
		},
		entered_game(message){
			this.game.users.push(message);
			this.game.transcript.push({signal:'entered_game',message:message});
		},
		left_game(message){
			var index = this.game.users.indexOf(message);
			if(index != -1){
				this.game.users.splice(index,1);
			}
			this.game.transcript.push({signal:'left_game',message:message});
		},
		said(message){
			this.game.transcript.push({signal:'said',message:message});
		}
	},
    created(){
    	this.connect();
    },
	watch:{
		username(){
			this.save_state();
		},
		game(){
			this.save_state();
		}
	},
    ready: function() {
        this.loading = false;
		this.$ws.rpc("echo",{message:"foobar"}).then((result)=>{
			this.message = result;
		});
		this.$ws.rpc("get_games",{}).then((result)=>{
			this.games = result;
			this.load_state();
		});
    }
});
