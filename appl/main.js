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
			username: null
		};
    },
	methods:{
		connect(){
			if(this.connected === false){
				this.$ws = new WS(this, ws_url);
			}
		},
		create_game(){

		},
		enter_game(){

		},
		leave_game(){
			
		}
	},
	events:{
		created_game(message){
			this.games.push(message);
		},
		entered_game(){
			this.game.users.push(message);
		},
		left_game(message){
			var index = this.game.users.indexOf(message);
			if(index != -1){
				this.game.users.splice(index,1);
			}
		},
		said(message){
			this.game.transcript.append(message);
		}
	},
    created(){
    	this.connect();
    },
    ready: function() {
        this.loading = false;
		this.$ws.rpc("echo",{message:"foobar"}).then((result)=>{
			this.message = result;
		});
    }
});
