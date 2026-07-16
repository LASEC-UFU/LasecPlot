class DataInputSerial extends DataInput{
    constructor(_connection, _name) {
        super(_connection, _name);
        this.port = null;
        this.sourceKey = null;
        this.sourceType = "serial";
        this.selectedDisplayName = "";
        this.baudrate = 115200;
        this.type = "serial";
        this.portList = [];
        this.listPorts();
        this.textToSend = "";
        this.endlineToSend = "";
        this.statusMessage = "";
        this.lasecSimulStatus = { availability: "not-installed", message: "LasecSimul não instalado" };
    }

    connect(){
        const source = this.portList.find(item => item.key === this.sourceKey);
        if (!source) {
            this.statusMessage = "Selecione uma fonte disponível.";
            return;
        }
        this.statusMessage = "Conectando...";
        this.sourceType = source.sourceType;
        this.selectedDisplayName = source.displayName;
        if (source.sourceType === "lasecsimul") {
            this.baudrate = source.baudRate;
            this.connection.sendServerCommand({
                id: this.id,
                cmd: "connectDataSource",
                sourceType: "lasecsimul",
                endpointId: source.endpointId
            });
            return;
        }
        let baud = parseInt(this.baudrate);
        this.port = source.path;
        this.connection.sendServerCommand({ id: this.id, cmd: "connectSerialPort", port: source.path, baud: baud})
    }

    disconnect(){
        this.connection.sendServerCommand({ id: this.id, cmd: "disconnectDataSource"})
    }

    onMessage(msg){
        if("data" in msg) {
            msg.input = this;
            parseData(msg);
        }
        else if("cmd" in msg) {
            if(msg.cmd == "serialPortList"){
                const previousKey = this.sourceKey;
                this.portList.length = 0;
                for(let serial of msg.list){
                //     if( serial.locationId
                //      || serial.serialNumber
                //      || serial.pnpId
                //      || serial.vendorId
                //      || serial.productId ){
                        this.portList.push(serial);
                    // }
                }
                this.lasecSimulStatus = msg.lasecSimul || this.lasecSimulStatus;
                if (!this.portList.some(item => item.key === previousKey)) {
                    this.sourceKey = this.portList.length ? this.portList[0].key : null;
                }
                this.onSourceChanged();
            }
            else if(msg.cmd == "serialPortConnect"){
                this.connected = true;
                this.statusMessage = "Conectado";
                if (msg.displayName) this.selectedDisplayName = msg.displayName;
                if (msg.sourceType) this.sourceType = msg.sourceType;
                if (msg.baud) this.baudrate = msg.baud;
            }
            else if(msg.cmd == "serialPortDisconnect"){
                this.connected = false;
                this.statusMessage = msg.message || "Desconectado";
            }
            else if(msg.cmd == "serialPortError"){
                this.connected = false;
                this.statusMessage = msg.message || "Falha ao abrir a fonte.";
            }
            else if(msg.cmd == "sourceWriteError"){
                this.statusMessage = msg.message || "Falha ao escrever na fonte.";
            }
        }
    }

    listPorts(){
        this.connection.sendServerCommand({ id: this.id, cmd: "listSerialPorts"});
    }

    selectedSource(){
        return this.portList.find(item => item.key === this.sourceKey);
    }

    onSourceChanged(){
        const source = this.selectedSource();
        if (!source) return;
        this.sourceType = source.sourceType;
        // Mantém a fonte virtual compatível com os controles que esperam uma "porta".
        this.port = source.path || source.displayName;
        this.selectedDisplayName = source.displayName;
        if (source.sourceType === "lasecsimul") this.baudrate = source.baudRate;
        this.statusMessage = "";
    }

    sendCommand(){
        //nope
    }

    updateCMDList(){
        //nope
    }

    sendText(text, lineEndings) {
        let escape = lineEndings.replace("\\n","\n");
        escape = escape.replace("\\r","\r");
        this.connection.sendServerCommand({ id: this.id, cmd: "sendToSerial", text: text+escape});
    }
}
