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
			message: ''
		};
    },
	methods:{
		connect(){
			if(this.connected === false){
				this.$ws = new WS(this, ws_url);
			}
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
